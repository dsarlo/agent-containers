/*
 * agent-containers-helper
 *
 * Package-owned, static, controlled remote execution helper for the
 * Codespaces backend (owner decision D4). This file is the single source of
 * truth for the wire protocol mirrored in src/codespaces-protocol.ts and the
 * latch-checked in scripts/verify-native-helper-packaging-contract.mjs.
 *
 * Design rules (spec section 9):
 *  - No shell string is ever executed. User argv travels inside length-prefixed
 *    frames on stdin and is passed to fork()+execvp() directly.
 *  - stdout/stderr (pipe mode) or the merged PTY terminal (pty mode) are logged
 *    durably under /workspaces/.agent-containers/<workspace_id>/commands/<id>/
 *    (spec 9.3 / N5) with byte offsets before offsets are acknowledged. Attach
 *    re-emits retained logs from the requested stream offsets (B2).
 *  - The owning serve process survives transport loss: on EOF it switches to a
 *    durable orphan pump that drains the child streams into the log files,
 *    reaps the child and records the final status. Transport loss and stdin
 *    half-close never SIGKILL the process group (B4).
 *  - Cancel proof requires the recorded owning process group; CANCEL_VERIFIED
 *    is emitted only after the group was signalled AND the server observed
 *    completion, within a bounded grace, never unconditional success (B3).
 *  - PTY mode allocates a real pty via posix_openpt/grantpt/unlockpt, merges
 *    child stdout+stderr into one terminal stream with \r\n translation, and
 *    honors AC_R_RESIZE winsize changes (B5).
 *  - Pipe mode uses a poll-based multiplexer over the stdin frame stream and
 *    the child stdin/stdout/stderr fds with bounded buffers and nonblocking
 *    writes so a child that reads stdin slowly while emitting stdout cannot
 *    deadlock (B6).
 *  - The hello handshake reports a compile-time architecture (N1).
 *  - No token, secret value, or credential-shaped data is ever accepted,
 *    displayed, stored, or logged.
 */
#define _GNU_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

/* === Wire protocol constants (mirror src/codespaces-protocol.ts) === */
#define AC_HELPER_PROTOCOL_VERSION 1
#define AC_MAX_FRAME_PAYLOAD (1024u * 1024u)
#define AC_OUTPUT_STDOUT 0u
#define AC_OUTPUT_STDERR 1u
#define AC_OUTPUT_TERMINAL 2u

enum ac_request_type {
  AC_R_HELLO = 0x01,
  AC_R_EXEC = 0x02,
  AC_R_ATTACH = 0x03,
  AC_R_CANCEL = 0x04,
  AC_R_RESIZE = 0x05,
  AC_R_STDIN = 0x06,
  AC_R_STDIN_EOF = 0x07,
};
enum ac_event_type {
  AC_E_HELLO_OK = 0x81,
  AC_E_REJECTED = 0x82,
  AC_E_STARTED = 0x83,
  AC_E_OUTPUT = 0x84,
  AC_E_STATUS = 0x85,
  AC_E_EXIT = 0x86,
  AC_E_CANCEL_VERIFIED = 0x87,
  AC_E_ERROR = 0x88,
  AC_E_CANCEL_UNKNOWN = 0x89,
};

#ifndef AC_HELPER_VERSION
#define AC_HELPER_VERSION "0.1.0"
#endif

#if defined(__aarch64__)
#define AC_HELPER_ARCH "aarch64"
#elif defined(__x86_64__)
#define AC_HELPER_ARCH "x86_64"
#else
#define AC_HELPER_ARCH "unknown"
#endif

#define AC_MAX_PATH 2400
#define AC_JPATH (AC_MAX_PATH + 128)
#define AC_FPATH (AC_MAX_PATH + 256)
#define AC_MAX_CMDLINE 16384

static char g_boot_id[64];

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  _exit(1);
}

static void read_boot_id(void) {
  FILE *f = fopen("/proc/sys/kernel/random/boot_id", "r");
  if (f == NULL) {
    strcpy(g_boot_id, "00000000-0000-0000-0000-000000000000");
    return;
  }
  size_t n = fread(g_boot_id, 1, sizeof(g_boot_id) - 1, f);
  fclose(f);
  while (n > 0 && (g_boot_id[n - 1] == '\n' || g_boot_id[n - 1] == '\r')) g_boot_id[--n] = '\0';
  g_boot_id[n] = '\0';
}

static void write_all(int fd, const void *buf, size_t len) {
  const unsigned char *p = (const unsigned char *)buf;
  while (len > 0) {
    ssize_t n = write(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return;
    }
    p += n;
    len -= (size_t)n;
  }
}

static int read_exact(int fd, void *buf, size_t len) {
  unsigned char *p = (unsigned char *)buf;
  while (len > 0) {
    ssize_t n = read(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (n == 0) return -1;
    p += n;
    len -= (size_t)n;
  }
  return 0;
}

static void emit_frame(uint8_t type, const void *payload, uint32_t length) {
  unsigned char header[5];
  header[0] = type;
  header[1] = (unsigned char)((length >> 24) & 0xff);
  header[2] = (unsigned char)((length >> 16) & 0xff);
  header[3] = (unsigned char)((length >> 8) & 0xff);
  header[4] = (unsigned char)(length & 0xff);
  write_all(STDOUT_FILENO, header, sizeof(header));
  if (length > 0) write_all(STDOUT_FILENO, payload, length);
}

static void emit_jsonf(uint8_t type, const char *fmt, ...) {
  char buf[AC_MAX_CMDLINE];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof(buf)) n = (int)sizeof(buf) - 1;
  emit_frame(type, buf, (uint32_t)n);
}

static void terminate_group(pid_t pgid, int sig);
static int group_alive(pid_t pgid);

/* A single length-prefixed frame read from the client side. */
struct ac_frame {
  uint8_t type;
  uint32_t length;
  unsigned char *payload;
};

static int read_frame(int fd, struct ac_frame *frame) {
  unsigned char header[5];
  if (read_exact(fd, header, sizeof(header)) != 0) return -1;
  frame->type = header[0];
  frame->length = ((uint32_t)header[1] << 24) | ((uint32_t)header[2] << 16) | ((uint32_t)header[3] << 8) | (uint32_t)header[4];
  if (frame->length > AC_MAX_FRAME_PAYLOAD) {
    emit_jsonf(AC_E_ERROR, "{\"command_id\":null,\"message\":\"oversized frame\"}");
    return -1;
  }
  frame->payload = NULL;
  if (frame->length > 0) {
    frame->payload = malloc(frame->length);
    if (frame->payload == NULL) return -1;
    if (read_exact(fd, frame->payload, frame->length) != 0) {
      free(frame->payload);
      frame->payload = NULL;
      return -1;
    }
  }
  return 0;
}

static void free_frame(struct ac_frame *frame) {
  free(frame->payload);
  frame->payload = NULL;
}

/* === Durable command tree (spec section 9.3 / N5) ===
 * <data_root>/<workspace_id>/commands/<command_id>/
 *   command.json  identity (argv, mode, pid, pgid)
 *   status.json   { state, exit_code, stdout_offset, stderr_offset, terminal_offset }
 *   helper.json   { protocol, arch, version }
 *   stdout.log / stderr.log (pipe) or terminal.log (pty) retained appends. */
static const char *helper_data_root(void) {
  const char *env = getenv("AC_HELPER_DATA_DIR");
  return (env != NULL && env[0] != '\0') ? env : "/workspaces/.agent-containers";
}

static void mkdir_p(const char *path) {
  char tmp[AC_JPATH];
  snprintf(tmp, sizeof(tmp), "%s", path);
  size_t len = strlen(tmp);
  while (len > 1 && tmp[len - 1] == '/') tmp[--len] = '\0';
  for (char *p = tmp + 1; *p != '\0'; p++) {
    if (*p == '/') {
      *p = '\0';
      (void)mkdir(tmp, 0700);
      *p = '/';
    }
  }
  (void)mkdir(tmp, 0700);
}

static void command_dir_path(const char *workspace_id, const char *command_id, char *out, size_t n) {
  snprintf(out, n, "%s/%s/commands/%s", helper_data_root(), workspace_id, command_id);
}

static void iso_timestamp(char *out, size_t n) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  struct tm tmv;
  if (gmtime_r(&ts.tv_sec, &tmv) == NULL) {
    snprintf(out, n, "1970-01-01T00:00:00Z");
    return;
  }
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
  memcpy(out, buf, sizeof(buf) < n ? sizeof(buf) : n);
  if (n > 0) out[n - 1] = '\0';
}

static void atomic_write_file(const char *path, const char *content) {
  char tmp[AC_FPATH + 8];
  snprintf(tmp, sizeof(tmp), "%s.tmp", path);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return;
  write_all(fd, content, strlen(content));
  (void)fsync(fd);
  close(fd);
  (void)rename(tmp, path);
}

/* JSON-escape an arbitrary UTF-8 string (sufficient for record JSON). */
static void json_string_escape(const char *in, char *out, size_t n) {
  size_t o = 0;
  for (const unsigned char *p = (const unsigned char *)in; *p != '\0' && o + 6 < n; p++) {
    switch (*p) {
      case '"': out[o++] = '\\'; out[o++] = '"'; break;
      case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
      case '\n': out[o++] = '\\'; out[o++] = 'n'; break;
      case '\r': out[o++] = '\\'; out[o++] = 'r'; break;
      case '\t': out[o++] = '\\'; out[o++] = 't'; break;
      case '\b': out[o++] = '\\'; out[o++] = 'b'; break;
      case '\f': out[o++] = '\\'; out[o++] = 'f'; break;
      default:
        if (*p < 0x20) {
          static const char hexd[] = "0123456789abcdef";
          out[o++] = '\\';
          out[o++] = 'u';
          out[o++] = '0';
          out[o++] = '0';
          out[o++] = hexd[(*p >> 4) & 0xf];
          out[o++] = hexd[*p & 0xf];
        } else {
          out[o++] = (char)*p;
        }
        break;
    }
  }
  out[o] = '\0';
}

/* Minimal JSON string token parse into `out`. Returns the parsed byte length,
 * or -1 on a malformed escape / unterminated string. `consumed` receives the
 * number of source bytes covered (including the closing quote), which keeps
 * outer array iteration aligned even for escaped tokens. */
static int json_string_token(const char *start, char *out, size_t n, size_t *consumed) {
  size_t o = 0;
  const unsigned char *p = (const unsigned char *)start;
  while (*p != '\0' && *p != '"') {
    if (*p == '\\') {
      p++;
      if (o + 1 >= n) return -1;
      switch (*p) {
        case 'n': out[o++] = '\n'; break;
        case 'r': out[o++] = '\r'; break;
        case 't': out[o++] = '\t'; break;
        case 'b': out[o++] = '\b'; break;
        case 'f': out[o++] = '\f'; break;
        case '"': out[o++] = '"'; break;
        case '\\': out[o++] = '\\'; break;
        case '/': out[o++] = '/'; break;
        case 'u': {
          if (p[1] == '\0' || p[2] == '\0' || p[3] == '\0' || p[4] == '\0') return -1;
          int v = 0;
          for (int i = 1; i <= 4; i++) {
            char c = (char)p[i];
            int d;
            if (c >= '0' && c <= '9') d = c - '0';
            else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
            else return -1;
            v = (v << 4) | d;
          }
          out[o++] = (char)v; /* surrogate pairs unsupported; fail closed */
          p += 4;
          break;
        }
        default:
          return -1;
      }
      p++;
    } else {
      if (o + 1 >= n) return -1;
      out[o++] = (char)*p;
      p++;
    }
  }
  if (*p != '"') return -1;
  *consumed = (size_t)((const unsigned char *)p - (const unsigned char *)start) + 1;
  out[o] = '\0';
  return (int)o;
}

/* Parse a JSON string array into argv (bounded, no shell interpretation).
 * Empty-string tokens are preserved; max_out bounds the vector. */
static int parse_argv(const char *payload, char **out, int max_out) {
  int count = 0;
  const char *cursor = strchr(payload, '[');
  if (cursor == NULL) return 0;
  while (count < max_out - 1) {
    cursor = strchr(cursor, '"');
    if (cursor == NULL) break;
    char token[1024];
    size_t consumed = 0;
    int len = json_string_token(cursor + 1, token, sizeof(token), &consumed);
    if (len < 0) return -1;
    char *alloc = malloc((size_t)len + 1);
    if (alloc == NULL) return -1;
    memcpy(alloc, token, (size_t)len + 1);
    out[count++] = alloc;
    cursor = cursor + 1 + consumed; /* past the closing quote */
    while (*cursor != '\0' && *cursor != '"' && *cursor != ']') cursor++;
    if (*cursor == ']') break;
  }
  out[count] = NULL;
  return count;
}

/* Extract a JSON scalar value for an exactly-quoted key: `"key":<value>`.
 * String values are unquoted; number/null/bool are copied verbatim. Returns
 * NULL when the key is absent so callers can distinguish missing vs present. */
static const char *json_value(const char *json, const char *key, char *out, size_t out_size) {
  size_t klen = strlen(key);
  const char *cursor = json;
  while ((cursor = strstr(cursor, key)) != NULL) {
    const char *before = cursor > json ? cursor - 1 : json;
    const char *after = cursor + klen;
    if (*before == '"' && *after == '"') {
      const char *colon = after + 1;
      while (*colon == ' ' || *colon == '\t') colon++;
      if (*colon != ':') { cursor = after + 1; continue; }
      const char *val = colon + 1;
      while (*val == ' ' || *val == '\t') val++;
      if (*val == '"') {
        const char *start = val + 1;
        const char *end = strchr(start, '"');
        if (end == NULL) break;
        size_t len = (size_t)(end - start);
        if (len + 1 < out_size && len < 8192) {
          memcpy(out, start, len);
          out[len] = '\0';
          return out;
        }
        break;
      }
      const char *end = val;
      while (*end != '\0' && *end != ',' && *end != '}' && *end != ']' && *end != '\n' && *end != ' ') end++;
      size_t len = (size_t)(end - val);
      if (len + 1 < out_size && len > 0 && len < 64) {
        memcpy(out, val, len);
        out[len] = '\0';
        return out;
      }
      break;
    }
    cursor = after;
  }
  out[0] = '\0';
  return NULL;
}

static void free_argv(char **argv, int argc) {
  for (int i = 0; i < argc; i++) {
    free(argv[i]);
    argv[i] = NULL;
  }
}

struct ac_run {
  char command_id[129];
  char request_hash[65];
  char workspace_id[128];
  char workdir[1024];
  char mode[8];
  char *argv[256];
  int argc;
  pid_t pid;
  int pgid;
  char log_dir[AC_JPATH];
  int stdin_fd;   /* pipe write end / pty master (both feed the child stdin) */
  int stdout_fd;  /* pipe read end from child stdout (pipe mode) */
  int stderr_fd;  /* pipe read end from child stderr (pipe mode) */
  int tty_fd;     /* pty master (pty mode) */
  uint64_t stdout_offset;
  uint64_t stderr_offset;
  uint64_t terminal_offset;
  FILE *stdout_log;
  FILE *stderr_log;
  FILE *terminal_log;
  int live;
  int framed; /* false once the transport is lost and we only log durably */
};

/* Derive the command directory from the validated identity fields. */
static void command_run_dir(struct ac_run *run) {
  command_dir_path(run->workspace_id, run->command_id, run->log_dir, sizeof(run->log_dir));
  mkdir_p(run->log_dir);
}

static void write_command_json(struct ac_run *run) {
  char path[AC_FPATH];
  snprintf(path, sizeof(path), "%s/command.json", run->log_dir);
  char buf[AC_MAX_CMDLINE];
  size_t off = 0;
  char escaped[1024];
  json_string_escape(run->command_id, escaped, sizeof(escaped));
  off += (size_t)snprintf(buf + off, sizeof(buf) - off, "{\"command_id\":\"%s\",\"request_hash\":\"%s\",\"workspace_id\":\"%s\",\"pid\":%ld,\"pgid\":%d,\"mode\":\"%s\",\"cwd\":\"",
                          escaped, run->request_hash, run->workspace_id, (long)run->pid, run->pgid, run->mode[0] != '\0' ? run->mode : "pipe");
  json_string_escape(run->workdir, escaped, sizeof(escaped));
  off += (size_t)snprintf(buf + off, sizeof(buf) - off, "%s\",\"argv\":[", escaped);
  for (int i = 0; i < run->argc && off + 1024 < sizeof(buf); i++) {
    json_string_escape(run->argv[i], escaped, sizeof(escaped));
    off += (size_t)snprintf(buf + off, sizeof(buf) - off, "%s\"%s\"", i == 0 ? "" : ",", escaped);
  }
  off += (size_t)snprintf(buf + off, sizeof(buf) - off, "]}");
  atomic_write_file(path, buf);
}

static void write_status_json(struct ac_run *run, const char *state, int exit_code) {
  char path[AC_FPATH];
  snprintf(path, sizeof(path), "%s/status.json", run->log_dir);
  char buf[1024];
  if (exit_code < 0) {
    snprintf(buf, sizeof(buf),
             "{\"command_id\":\"%s\",\"state\":\"%s\",\"exit_code\":null,\"stdout_offset\":%" PRIu64 ",\"stderr_offset\":%" PRIu64 ",\"terminal_offset\":%" PRIu64 ",\"started_at\":\"%ld\",\"exited_at\":null}\n",
             run->command_id, state, run->stdout_offset, run->stderr_offset, run->terminal_offset, (long)time(NULL));
  } else {
    snprintf(buf, sizeof(buf),
             "{\"command_id\":\"%s\",\"state\":\"%s\",\"exit_code\":%d,\"stdout_offset\":%" PRIu64 ",\"stderr_offset\":%" PRIu64 ",\"terminal_offset\":%" PRIu64 ",\"started_at\":\"%ld\",\"exited_at\":\"%ld\"}\n",
             run->command_id, state, exit_code, run->stdout_offset, run->stderr_offset, run->terminal_offset, (long)time(NULL), (long)time(NULL));
  }
  atomic_write_file(path, buf);
}

static void open_command_logs(struct ac_run *run) {
  char path[AC_FPATH];
  snprintf(path, sizeof(path), "%s/stdout.log", run->log_dir);
  run->stdout_log = fopen(path, "ab");
  snprintf(path, sizeof(path), "%s/stderr.log", run->log_dir);
  run->stderr_log = fopen(path, "ab");
  snprintf(path, sizeof(path), "%s/terminal.log", run->log_dir);
  run->terminal_log = fopen(path, "ab");
  char helper_path[AC_FPATH];
  snprintf(helper_path, sizeof(helper_path), "%s/helper.json", run->log_dir);
  char hj[512];
  snprintf(hj, sizeof(hj), "{\"protocol\":%d,\"arch\":\"%s\",\"version\":\"%s\"}\n", AC_HELPER_PROTOCOL_VERSION, AC_HELPER_ARCH, AC_HELPER_VERSION);
  atomic_write_file(helper_path, hj);
}

static void close_command_logs(struct ac_run *run) {
  if (run->stdout_log != NULL) { fclose(run->stdout_log); run->stdout_log = NULL; }
  if (run->stderr_log != NULL) { fclose(run->stderr_log); run->stderr_log = NULL; }
  if (run->terminal_log != NULL) { fclose(run->terminal_log); run->terminal_log = NULL; }
}

static void append_stream_log(FILE *log, uint64_t *offset, const unsigned char *bytes, size_t len) {
  if (log == NULL) return;
  if (fwrite(bytes, 1, len, log) == len) {
    fflush(log);
    *offset += (uint64_t)len;
  }
}

/* Emit output event frames carrying the durable offset for the given stream. */
static void emit_output(uint8_t stream, uint64_t offset, const unsigned char *bytes, size_t len) {
  const size_t available = AC_MAX_FRAME_PAYLOAD - 9;
  while (len > 0) {
    size_t chunk = len < available ? len : available;
    unsigned char *payload = malloc(9 + chunk);
    if (payload == NULL) return;
    payload[0] = (unsigned char)stream;
    payload[1] = (unsigned char)((offset >> 56) & 0xff);
    payload[2] = (unsigned char)((offset >> 48) & 0xff);
    payload[3] = (unsigned char)((offset >> 40) & 0xff);
    payload[4] = (unsigned char)((offset >> 32) & 0xff);
    payload[5] = (unsigned char)((offset >> 24) & 0xff);
    payload[6] = (unsigned char)((offset >> 16) & 0xff);
    payload[7] = (unsigned char)((offset >> 8) & 0xff);
    payload[8] = (unsigned char)(offset & 0xff);
    memcpy(payload + 9, bytes, chunk);
    emit_frame(AC_E_OUTPUT, payload, (uint32_t)(9 + chunk));
    free(payload);
    bytes += chunk;
    len -= chunk;
    offset += (uint64_t)chunk;
  }
}

/* Bounded nonblocking stdin buffer for a slow-reading child (B6). */
struct ac_stdin_q {
  unsigned char *buf;
  size_t len;
  size_t cap;
};

static int stdin_q_reserve(struct ac_stdin_q *q, size_t extra) {
  if (q->len + extra <= q->cap) return 0;
  size_t want = q->cap != 0 ? q->cap : 4096;
  while (want < q->len + extra) want *= 2;
  if (want > (4u * 1024u * 1024u)) return -1;
  unsigned char *next = realloc(q->buf, want);
  if (next == NULL) return -1;
  q->buf = next;
  q->cap = want;
  return 0;
}

static void stdin_q_flush(int fd, struct ac_stdin_q *q) {
  while (q->len > 0) {
    ssize_t n = write(fd, q->buf, q->len);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      q->len = 0; /* child side closed; drop pending bytes to avoid a spin */
      return;
    }
    if (n == 0) return;
    memmove(q->buf, q->buf + n, q->len - (size_t)n);
    q->len -= (size_t)n;
    if (q->len == 0) break;
  }
}

/* Poll-based drain of child output streams into durable logs + frames.
 * Reads at most one full buffer per fd per call so a chatty stream can never
 * starve concurrent stdin frames (B6). */
static void pump_once(struct ac_run *run) {
  struct pollfd fds[3];
  int nfds = 0;
  if (run->stdout_fd >= 0) fds[nfds++] = (struct pollfd){ .fd = run->stdout_fd, .events = POLLIN };
  if (run->stderr_fd >= 0) fds[nfds++] = (struct pollfd){ .fd = run->stderr_fd, .events = POLLIN };
  if (run->tty_fd >= 0) fds[nfds++] = (struct pollfd){ .fd = run->tty_fd, .events = POLLIN };
  int rc = poll(fds, (nfds_t)nfds, 0);
  if (rc < 0) {
    if (errno == EINTR) return;
    return;
  }
  unsigned char buf[65536];
  for (int i = 0; i < nfds; i++) {
    if (!(fds[i].revents & (POLLIN | POLLHUP))) continue;
    int fd = fds[i].fd;
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n > 0) {
      if (fd == run->stdout_fd) {
        append_stream_log(run->stdout_log, &run->stdout_offset, buf, (size_t)n);
        if (run->framed) emit_output(AC_OUTPUT_STDOUT, run->stdout_offset - (uint64_t)n, buf, (size_t)n);
      } else if (fd == run->stderr_fd) {
        append_stream_log(run->stderr_log, &run->stderr_offset, buf, (size_t)n);
        if (run->framed) emit_output(AC_OUTPUT_STDERR, run->stderr_offset - (uint64_t)n, buf, (size_t)n);
      } else {
        append_stream_log(run->terminal_log, &run->terminal_offset, buf, (size_t)n);
        if (run->framed) emit_output(AC_OUTPUT_TERMINAL, run->terminal_offset - (uint64_t)n, buf, (size_t)n);
      }
      continue;
    }
    if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) {
      if (fd == run->stdout_fd) { close(run->stdout_fd); run->stdout_fd = -1; }
      else if (fd == run->stderr_fd) { close(run->stderr_fd); run->stderr_fd = -1; }
      else if (fd == run->tty_fd) { close(run->tty_fd); run->tty_fd = -1; }
    }
  }
}

static int run_pipe(struct ac_run *run) {
  int in_pipe[2];
  int out_pipe[2];
  int err_pipe[2];
  if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0 || pipe(err_pipe) != 0) {
    emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"pipe\"}", run->command_id);
    return -1;
  }
  pid_t pid = fork();
  if (pid < 0) {
    emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"spawn\"}", run->command_id);
    return -1;
  }
  if (pid == 0) {
    setpgid(0, 0);
    dup2(in_pipe[0], STDIN_FILENO);
    dup2(out_pipe[1], STDOUT_FILENO);
    dup2(err_pipe[1], STDERR_FILENO);
    close(in_pipe[0]);
    close(in_pipe[1]);
    close(out_pipe[0]);
    close(out_pipe[1]);
    close(err_pipe[0]);
    close(err_pipe[1]);
    if (run->workdir[0] != '\0') {
      if (chdir(run->workdir) != 0) _exit(126);
    }
    execvp(run->argv[0], run->argv);
    _exit(127);
  }
  run->pid = pid;
  run->pgid = (int)pid;
  run->stdin_fd = in_pipe[1];
  run->stdout_fd = out_pipe[0];
  run->stderr_fd = err_pipe[0];
  close(in_pipe[0]);
  close(out_pipe[1]);
  close(err_pipe[1]);
  int flags = fcntl(run->stdin_fd, F_GETFL, 0);
  (void)fcntl(run->stdin_fd, F_SETFL, flags | O_NONBLOCK);
  return 0;
}

/* PTY spawn: posix_openpt/grantpt/unlockpt with termios kept at defaults so
 * the merged terminal stream carries \r\n translation, plus a settable
 * winsize honored by AC_R_RESIZE (B5). */
static int run_pty(struct ac_run *run, int cols, int rows) {
  int master = posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0) {
    emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"pty-open\"}", run->command_id);
    return -1;
  }
  if (grantpt(master) != 0 || unlockpt(master) != 0) {
    close(master);
    emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"pty-unlock\"}", run->command_id);
    return -1;
  }
  char slave_name[256];
  if (ptsname_r(master, slave_name, sizeof(slave_name)) != 0) {
    close(master);
    emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"pty-name\"}", run->command_id);
    return -1;
  }
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);
  ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
  (void)ioctl(master, TIOCSWINSZ, &ws);
  int slave = open(slave_name, O_RDWR | O_NOCTTY);
  if (slave < 0) {
    close(master);
    emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"pty-slave\"}", run->command_id);
    return -1;
  }
  pid_t pid = fork();
  if (pid < 0) {
    close(master);
    close(slave);
    emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"spawn\"}", run->command_id);
    return -1;
  }
  if (pid == 0) {
    setsid();
    setpgid(0, 0);
    (void)ioctl(slave, TIOCSCTTY, 0);
    dup2(slave, STDIN_FILENO);
    dup2(slave, STDOUT_FILENO);
    dup2(slave, STDERR_FILENO);
    if (slave > STDERR_FILENO) close(slave);
    close(master);
    if (run->workdir[0] != '\0') {
      if (chdir(run->workdir) != 0) _exit(126);
    }
    execvp(run->argv[0], run->argv);
    _exit(127);
  }
  close(slave);
  run->pid = pid;
  run->pgid = (int)pid;
  run->tty_fd = master;
  run->stdin_fd = master;
  int flags = fcntl(run->stdin_fd, F_GETFL, 0);
  (void)fcntl(run->stdin_fd, F_SETFL, flags | O_NONBLOCK);
  return 0;
}

static int spawn_command(struct ac_run *run, int pty, int cols, int rows) {
  command_run_dir(run);
  open_command_logs(run);
  int rc;
  if (pty) rc = run_pty(run, cols, rows);
  else rc = run_pipe(run);
  if (rc != 0) {
    close_command_logs(run);
    return -1;
  }
  write_command_json(run);
  write_status_json(run, "running", -1);
  char iso[48];
  iso_timestamp(iso, sizeof(iso));
  emit_jsonf(AC_E_STARTED, "{\"command_id\":\"%s\",\"pid\":%ld,\"started_at\":\"%s\",\"remote_boot_id\":\"%s\"}",
             run->command_id, (long)run->pid, iso, g_boot_id);
  run->live = 1;
  run->framed = 1;
  return 0;
}

static void record_child_exit(struct ac_run *run, int code) {
  pump_once(run);
  char iso[48];
  iso_timestamp(iso, sizeof(iso));
  /* Persist the exited state durably BEFORE announcing it: the exit event is
   * the client-visible commitment, and it must never race the status write or
   * leave status.json at "running" after exit was reported (durability order). */
  write_status_json(run, "exited", code);
  if (run->framed) emit_jsonf(AC_E_EXIT, "{\"command_id\":\"%s\",\"code\":%d,\"exited_at\":\"%s\"}", run->command_id, code, iso);
  run->live = 0;
}

/* Cancel proof inside the owning session: signal the group, then only claim
 * CANCEL_VERIFIED once the server observed the reap; a bounded grace yields an
 * explicit CANCEL_UNKNOWN, never unconditional success (B3). */
static int cancel_owned(struct ac_run *run, int grace_ms) {
  if (run->pgid <= 1) {
    if (run->framed) emit_jsonf(AC_E_CANCEL_UNKNOWN, "{\"command_id\":\"%s\",\"message\":\"no-owning-pgid\"}", run->command_id);
    return 2;
  }
  terminate_group(run->pgid, SIGTERM);
  long deadline_ms = (long)grace_ms > 0 ? (long)grace_ms : 5000L;
  long waited = 0;
  while (waited < deadline_ms) {
    int wstatus = 0;
    pid_t r = waitpid(run->pid, &wstatus, WNOHANG);
    if (r == run->pid) {
      (void)pump_once(run);
      write_status_json(run, "cancelled", 130);
      char iso[48];
      iso_timestamp(iso, sizeof(iso));
      if (run->framed) emit_jsonf(AC_E_CANCEL_VERIFIED, "{\"command_id\":\"%s\",\"cancelled_at\":\"%s\"}", run->command_id, iso);
      run->live = 0;
      return 1;
    }
    if (run->stdout_fd >= 0 || run->stderr_fd >= 0 || run->tty_fd >= 0) pump_once(run);
    (void)usleep(20000);
    waited += 20;
  }
  /* second TERM, then give up within the bound */
  terminate_group(run->pgid, SIGTERM);
  while (waited < deadline_ms + 2000L) {
    int wstatus = 0;
    if (waitpid(run->pid, &wstatus, WNOHANG) == run->pid) {
      (void)pump_once(run);
      write_status_json(run, "cancelled", 130);
      char iso[48];
      iso_timestamp(iso, sizeof(iso));
      if (run->framed) emit_jsonf(AC_E_CANCEL_VERIFIED, "{\"command_id\":\"%s\",\"cancelled_at\":\"%s\"}", run->command_id, iso);
      run->live = 0;
      return 1;
    }
    if (run->stdout_fd >= 0 || run->stderr_fd >= 0 || run->tty_fd >= 0) pump_once(run);
    (void)usleep(20000);
    waited += 20;
  }
  if (run->framed) emit_jsonf(AC_E_CANCEL_UNKNOWN, "{\"command_id\":\"%s\",\"message\":\"grace-expired\"}", run->command_id);
  return 2;
}

/* Load the recorded identity for a command (workspace-scoped). Returns 0 when
 * the record is absent or malformed. */
static int load_record(const char *workspace_id, const char *command_id, pid_t *pid_out, int *pgid_out) {
  char dir[AC_JPATH];
  command_dir_path(workspace_id, command_id, dir, sizeof(dir));
  char path[AC_FPATH];
  snprintf(path, sizeof(path), "%s/command.json", dir);
  FILE *f = fopen(path, "r");
  if (f == NULL) return 0;
  char buf[AC_MAX_CMDLINE];
  size_t n = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  buf[n] = '\0';
  char pid_s[32];
  char pgid_s[32];
  if (json_value(buf, "pid", pid_s, sizeof(pid_s)) == NULL) return 0;
  if (json_value(buf, "pgid", pgid_s, sizeof(pgid_s)) == NULL) return 0;
  char *end = NULL;
  errno = 0;
  long pid = strtol(pid_s, &end, 10);
  if (errno != 0 || pid <= 0 || end == pid_s) return 0;
  end = NULL;
  errno = 0;
  long pgid = strtol(pgid_s, &end, 10);
  if (errno != 0 || end == pgid_s) return 0;
  *pid_out = (pid_t)pid;
  *pgid_out = (int)pgid;
  return 1;
}

/* Read status.json state + exit code. Returns 0 when absent. */
static int load_status_json(const char *workspace_id, const char *command_id, char *state, size_t state_n, int *exit_code) {
  char dir[AC_JPATH];
  command_dir_path(workspace_id, command_id, dir, sizeof(dir));
  char path[AC_FPATH];
  snprintf(path, sizeof(path), "%s/status.json", dir);
  FILE *f = fopen(path, "r");
  if (f == NULL) return 0;
  char buf[2048];
  size_t n = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  buf[n] = '\0';
  if (json_value(buf, "state", state, state_n) == NULL) return 0;
  char code_s[32];
  if (json_value(buf, "exit_code", code_s, sizeof(code_s)) != NULL && code_s[0] != 'n') {
    char *end = NULL;
    long code = strtol(code_s, &end, 10);
    if (end != code_s) *exit_code = (int)code;
  }
  return 1;
}

/* Cross-session (fresh connection) cancel: the fresh run has no owning pgid,
 * so the recorded pgid is used and proof is reported only after the owning
 * server observed the completion in status.json within the bounded grace (B3). */
static void write_status_direct(const char *dir, const char *command_id, const char *state, int exit_code);
static int cancel_cross(const char *workspace_id, const char *command_id, int grace_ms) {
  pid_t pid = 0;
  int pgid = 0;
  if (!load_record(workspace_id, command_id, &pid, &pgid)) {
    emit_jsonf(AC_E_CANCEL_UNKNOWN, "{\"command_id\":\"%s\",\"message\":\"attach-not-recorded\"}", command_id);
    return 2;
  }
  if (pgid <= 1) {
    emit_jsonf(AC_E_CANCEL_UNKNOWN, "{\"command_id\":\"%s\",\"message\":\"no-owning-pgid\"}", command_id);
    return 2;
  }
  terminate_group(pgid, SIGTERM);
  long deadline_ms = (long)grace_ms > 0 ? (long)grace_ms : 5000L;
  long waited = 0;
  int verified = 0;
  while (waited < deadline_ms) {
    if (!group_alive(pgid) || waitpid(pid, NULL, WNOHANG) == pid) {
      char s2[64];
      int c2 = -1;
      if (load_status_json(workspace_id, command_id, s2, sizeof(s2), &c2) && strcmp(s2, "running") != 0) {
        verified = 1;
        break;
      }
    }
    (void)usleep(20000);
    waited += 20;
  }
  if (verified) {
    char dir[AC_JPATH];
    command_dir_path(workspace_id, command_id, dir, sizeof(dir));
    write_status_direct(dir, command_id, "cancelled", 130);
    char iso[48];
    iso_timestamp(iso, sizeof(iso));
    emit_jsonf(AC_E_CANCEL_VERIFIED, "{\"command_id\":\"%s\",\"cancelled_at\":\"%s\"}", command_id, iso);
    return 1;
  }
  emit_jsonf(AC_E_CANCEL_UNKNOWN, "{\"command_id\":\"%s\",\"message\":\"grace-expired\"}", command_id);
  return 2;
}

/* Drive a freshly exec'd command to completion with a poll-based multiplexer
 * over the stdin frame stream and the child streams (B6). Returns:
 *   0 exited, 1 cancelled, 2 cancel-unknown, 3 transported to the orphan pump. */
static int drive_exec(struct ac_run *run, int grace_ms) {
  struct ac_stdin_q q;
  memset(&q, 0, sizeof(q));
  int transport_open = 1;
  for (;;) {
    int wstatus = 0;
    pid_t waited = waitpid(run->pid, &wstatus, WNOHANG);
    if (waited == run->pid) {
      int code;
      if (WIFEXITED(wstatus)) code = WEXITSTATUS(wstatus);
      else if (WIFSIGNALED(wstatus)) code = 128 + WTERMSIG(wstatus);
      else code = 1;
      record_child_exit(run, code);
      free(q.buf);
      return 0;
    }
    struct pollfd fds[5];
    int nfds = 0;
    if (transport_open) {
      fds[nfds++] = (struct pollfd){ .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
    }
    if (run->tty_fd >= 0 && run->stdin_fd == run->tty_fd) {
      fds[nfds++] = (struct pollfd){ .fd = run->tty_fd, .events = POLLIN | POLLOUT };
    } else {
      if (run->stdin_fd >= 0) fds[nfds++] = (struct pollfd){ .fd = run->stdin_fd, .events = POLLOUT };
      if (run->stdout_fd >= 0) fds[nfds++] = (struct pollfd){ .fd = run->stdout_fd, .events = POLLIN };
      if (run->stderr_fd >= 0) fds[nfds++] = (struct pollfd){ .fd = run->stderr_fd, .events = POLLIN };
    }
    int rc = poll(fds, (nfds_t)nfds, 50);
    if (rc < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (rc == 0) continue;
    for (int i = 0; i < nfds; i++) {
      short revents = fds[i].revents;
      int fd = fds[i].fd;
      if (fd == STDIN_FILENO) {
        if (revents & (POLLIN | POLLHUP)) {
          struct ac_frame frame;
          if (read_frame(STDIN_FILENO, &frame) != 0) {
            transport_open = 0;
            continue;
          }
          if (frame.type == AC_R_STDIN) {
            if (run->stdin_fd >= 0 && frame.length > 0 && stdin_q_reserve(&q, frame.length) == 0) {
              memcpy(q.buf + q.len, frame.payload, frame.length);
              q.len += frame.length;
              stdin_q_flush(run->stdin_fd, &q);
            }
          } else if (frame.type == AC_R_STDIN_EOF) {
            if (run->stdin_fd >= 0) {
              stdin_q_flush(run->stdin_fd, &q);
              close(run->stdin_fd);
              run->stdin_fd = -1;
            }
            q.len = 0;
          } else if (frame.type == AC_R_CANCEL) {
            int outcome = cancel_owned(run, grace_ms);
            free_frame(&frame);
            free(q.buf);
            return outcome;
          } else if (frame.type == AC_R_RESIZE && run->tty_fd >= 0) {
            char cols_s[16];
            char rows_s[16];
            if (json_value((const char *)frame.payload, "cols", cols_s, sizeof(cols_s)) != NULL
                && json_value((const char *)frame.payload, "rows", rows_s, sizeof(rows_s)) != NULL) {
              char *end = NULL;
              long cols = strtol(cols_s, &end, 10);
              end = NULL;
              long rows = strtol(rows_s, &end, 10);
              if (cols > 0 && cols <= 8192 && rows > 0 && rows <= 8192) {
                struct winsize ws;
                memset(&ws, 0, sizeof(ws));
                ws.ws_col = (unsigned short)cols;
                ws.ws_row = (unsigned short)rows;
                (void)ioctl(run->tty_fd, TIOCSWINSZ, &ws);
              }
            }
          }
          free_frame(&frame);
        }
      } else if (run->tty_fd >= 0 && run->stdin_fd == run->tty_fd && fd == run->tty_fd) {
        if (revents & POLLIN) {
          pump_once(run);
        }
        if ((revents & POLLOUT) && q.len > 0) stdin_q_flush(run->stdin_fd, &q);
      } else {
        if (revents & (POLLIN | POLLHUP)) pump_once(run);
        if ((revents & POLLOUT) && fd == run->stdin_fd && q.len > 0) stdin_q_flush(run->stdin_fd, &q);
      }
    }
    if (!transport_open) {
      free(q.buf);
      return 3;
    }
  }
  free(q.buf);
  return 0;
}

/* Durable orphan pump after transport loss: no frames are emitted, the child
 * streams keep draining into the durable logs, the child is reaped and the
 * final status recorded. This is the ONLY post-loss owner (B4). */
static void orphan_pump(struct ac_run *run) {
  run->framed = 0;
  while (run->live) {
    int wstatus = 0;
    pid_t waited = waitpid(run->pid, &wstatus, WNOHANG);
    if (waited == run->pid) {
      int code;
      if (WIFEXITED(wstatus)) code = WEXITSTATUS(wstatus);
      else if (WIFSIGNALED(wstatus)) code = 128 + WTERMSIG(wstatus);
      else code = 1;
      record_child_exit(run, code);
      break;
    }
    if (run->stdout_fd >= 0 || run->stderr_fd >= 0 || run->tty_fd >= 0) pump_once(run);
    (void)usleep(20000);
  }
  if (run->stdin_fd >= 0) { close(run->stdin_fd); run->stdin_fd = -1; }
}

/* Open a retained log file positioned at `from`; returns the fd and the
 * current on-disk EOF, or -1 when the log is absent / offset is beyond EOF. */
static int open_log_at(const char *dir, const char *name, uint64_t from, uint64_t *end) {
  char path[AC_FPATH];
  snprintf(path, sizeof(path), "%s/%s", dir, name);
  int fd = open(path, O_RDONLY);
  if (fd < 0) return -1;
  struct stat st;
  if (fstat(fd, &st) != 0) { close(fd); return -1; }
  uint64_t size = (uint64_t)st.st_size;
  if (from > size) { close(fd); return -1; }
  *end = size;
  if (lseek(fd, (off_t)from, SEEK_SET) < 0) { close(fd); return -1; }
  return fd;
}

/* Emit every retained byte from the current position of an open log fd. */
static void emit_log_remaining(uint8_t stream, uint64_t from, int fd) {
  unsigned char buf[65536];
  uint64_t offset = from;
  for (;;) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n <= 0) break;
    emit_output(stream, offset, buf, (size_t)n);
    offset += (uint64_t)n;
  }
}

static void write_status_direct(const char *dir, const char *command_id, const char *state, int exit_code) {
  char path[AC_FPATH];
  snprintf(path, sizeof(path), "%s/status.json", dir);
  uint64_t so = 0;
  uint64_t se = 0;
  uint64_t to = 0;
  {
    char p[AC_FPATH];
    struct stat st;
    snprintf(p, sizeof(p), "%s/stdout.log", dir);
    if (stat(p, &st) == 0) so = (uint64_t)st.st_size;
    snprintf(p, sizeof(p), "%s/stderr.log", dir);
    if (stat(p, &st) == 0) se = (uint64_t)st.st_size;
    snprintf(p, sizeof(p), "%s/terminal.log", dir);
    if (stat(p, &st) == 0) to = (uint64_t)st.st_size;
  }
  char buf[1024];
  if (exit_code < 0) {
    snprintf(buf, sizeof(buf),
             "{\"command_id\":\"%s\",\"state\":\"%s\",\"exit_code\":null,\"stdout_offset\":%" PRIu64 ",\"stderr_offset\":%" PRIu64 ",\"terminal_offset\":%" PRIu64 ",\"started_at\":\"%ld\",\"exited_at\":null}\n",
             command_id, state, so, se, to, (long)time(NULL));
  } else {
    snprintf(buf, sizeof(buf),
             "{\"command_id\":\"%s\",\"state\":\"%s\",\"exit_code\":%d,\"stdout_offset\":%" PRIu64 ",\"stderr_offset\":%" PRIu64 ",\"terminal_offset\":%" PRIu64 ",\"started_at\":\"%ld\",\"exited_at\":\"%ld\"}\n",
             command_id, state, exit_code, so, se, to, (long)time(NULL), (long)time(NULL));
  }
  atomic_write_file(path, buf);
}

/* AC_R_ATTACH: re-emit retained logs from the requested stream offsets, then
 * live-tail the durable logs appended by the owning serve process until the
 * recorded status flips to exited (then the exact exit status is delivered) or
 * the client cancels (B2/N5). Unknown or unrecorded commands are rejected. */
static void handle_attach(struct ac_frame *frame, int grace_ms) {
  char workspace_id[128];
  char command_id[129];
  uint64_t stdout_from = 0;
  uint64_t stderr_from = 0;
  uint64_t terminal_from = 0;
  if (json_value((const char *)frame->payload, "command_id", command_id, sizeof(command_id)) == NULL) {
    emit_jsonf(AC_E_REJECTED, "{\"command_id\":null,\"reason\":\"missing-command-id\"}");
    return;
  }
  if (json_value((const char *)frame->payload, "workspace_id", workspace_id, sizeof(workspace_id)) == NULL) {
    workspace_id[0] = '\0';
  }
  {
    char s[64];
    if (json_value((const char *)frame->payload, "stdout_offset", s, sizeof(s)) != NULL) {
      char *end = NULL;
      uint64_t v = (uint64_t)strtoull(s, &end, 10);
      if (end != s) stdout_from = v;
    }
    if (json_value((const char *)frame->payload, "stderr_offset", s, sizeof(s)) != NULL) {
      char *end = NULL;
      uint64_t v = (uint64_t)strtoull(s, &end, 10);
      if (end != s) stderr_from = v;
    }
    if (json_value((const char *)frame->payload, "terminal_offset", s, sizeof(s)) != NULL) {
      char *end = NULL;
      uint64_t v = (uint64_t)strtoull(s, &end, 10);
      if (end != s) terminal_from = v;
    }
  }
  char dir[AC_JPATH];
  command_dir_path(workspace_id, command_id, dir, sizeof(dir));
  struct ac_run run;
  memset(&run, 0, sizeof(run));
  snprintf(run.command_id, sizeof(run.command_id), "%s", command_id);
  snprintf(run.workspace_id, sizeof(run.workspace_id), "%s", workspace_id);
  snprintf(run.log_dir, sizeof(run.log_dir), "%s", dir);
  run.stdout_fd = -1;
  run.stderr_fd = -1;
  run.stdin_fd = -1;
  run.tty_fd = -1;
  run.framed = 1;
  run.live = 0;

  int have_record = load_record(workspace_id, command_id, &run.pid, &run.pgid);
  char state[64];
  int exit_code = -1;
  int have_status = load_status_json(workspace_id, command_id, state, sizeof(state), &exit_code);
  if (!have_record || !have_status) {
    emit_jsonf(AC_E_REJECTED, "{\"command_id\":\"%s\",\"reason\":\"attach-not-recorded\"}", command_id);
    return;
  }
  uint64_t stdout_end = 0;
  uint64_t stderr_end = 0;
  uint64_t terminal_end = 0;
  int stdout_fd = open_log_at(dir, "stdout.log", stdout_from, &stdout_end);
  int stderr_fd = open_log_at(dir, "stderr.log", stderr_from, &stderr_end);
  int terminal_fd = open_log_at(dir, "terminal.log", terminal_from, &terminal_end);
  if (stdout_fd < 0 && stderr_fd < 0 && terminal_fd < 0) {
    emit_jsonf(AC_E_REJECTED, "{\"command_id\":\"%s\",\"reason\":\"attach-offset-beyond-retention\"}", command_id);
    return;
  }
  char ec[16];
  if (exit_code < 0) snprintf(ec, sizeof(ec), "null");
  else snprintf(ec, sizeof(ec), "%d", exit_code);
  emit_jsonf(AC_E_STATUS, "{\"command_id\":\"%s\",\"state\":\"%s\",\"exit_code\":%s,\"stdout_offset\":%" PRIu64 ",\"stderr_offset\":%" PRIu64 ",\"terminal_offset\":%" PRIu64 "}",
             command_id, state, ec, stdout_end, stderr_end, terminal_end);
  if (stdout_fd >= 0) { emit_log_remaining(AC_OUTPUT_STDOUT, stdout_from, stdout_fd); close(stdout_fd); }
  if (stderr_fd >= 0) { emit_log_remaining(AC_OUTPUT_STDERR, stderr_from, stderr_fd); close(stderr_fd); }
  if (terminal_fd >= 0) { emit_log_remaining(AC_OUTPUT_TERMINAL, terminal_from, terminal_fd); close(terminal_fd); }

  if (strcmp(state, "running") == 0 && group_alive(run.pgid)) {
    /* Live-tail durable logs appended by the owning serve process (B2). */
    struct ac_stdin_q q;
    memset(&q, 0, sizeof(q));
    int transport_open = 1;
    for (;;) {
      uint64_t e = 0;
      int fd = open_log_at(dir, "stdout.log", stdout_end, &e);
      if (fd >= 0) { emit_log_remaining(AC_OUTPUT_STDOUT, stdout_end, fd); close(fd); stdout_end = e; }
      fd = open_log_at(dir, "stderr.log", stderr_end, &e);
      if (fd >= 0) { emit_log_remaining(AC_OUTPUT_STDERR, stderr_end, fd); close(fd); stderr_end = e; }
      fd = open_log_at(dir, "terminal.log", terminal_end, &e);
      if (fd >= 0) { emit_log_remaining(AC_OUTPUT_TERMINAL, terminal_end, fd); close(fd); terminal_end = e; }
      int wstatus = 0;
      if (waitpid(run.pid, &wstatus, WNOHANG) == run.pid) {
        int code = WIFEXITED(wstatus) ? WEXITSTATUS(wstatus) : (WIFSIGNALED(wstatus) ? 128 + WTERMSIG(wstatus) : 1);
        char iso[48];
        iso_timestamp(iso, sizeof(iso));
        emit_jsonf(AC_E_EXIT, "{\"command_id\":\"%s\",\"code\":%d,\"exited_at\":\"%s\"}", command_id, code, iso);
        break;
      }
      char s2[64];
      int c2 = -1;
      if (load_status_json(workspace_id, command_id, s2, sizeof(s2), &c2) && strcmp(s2, "running") != 0) {
        c2 = c2 < 0 ? 1 : c2;
        char iso[48];
        iso_timestamp(iso, sizeof(iso));
        emit_jsonf(AC_E_EXIT, "{\"command_id\":\"%s\",\"code\":%d,\"exited_at\":\"%s\"}", command_id, c2, iso);
        break;
      }
      struct pollfd pf;
      pf.fd = STDIN_FILENO;
      pf.events = POLLIN | POLLHUP;
      if (poll(&pf, 1, 100) > 0 && (pf.revents & (POLLIN | POLLHUP))) {
        struct ac_frame mid;
        if (read_frame(STDIN_FILENO, &mid) != 0) {
          transport_open = 0;
          break;
        }
        if (mid.type == AC_R_CANCEL) {
          int outcome = cancel_cross(workspace_id, command_id, grace_ms);
          free_frame(&mid);
          free(q.buf);
          if (outcome == 1) {
            emit_jsonf(AC_E_STATUS, "{\"command_id\":\"%s\",\"state\":\"cancelled\",\"exit_code\":130}", command_id);
          }
          return;
        }
        free_frame(&mid);
      }
    }
    free(q.buf);
    if (!transport_open) return;
    return;
  }
  /* recorded exited / cancelled → deliver the exact retained exit status */
  if (strcmp(state, "exited") == 0 || strcmp(state, "cancelled") == 0) {
    char iso[48];
    iso_timestamp(iso, sizeof(iso));
    emit_jsonf(AC_E_EXIT, "{\"command_id\":\"%s\",\"code\":%d,\"exited_at\":\"%s\"}", command_id, exit_code < 0 ? 1 : exit_code, iso);
    return;
  }
  /* recorded running but the group is gone (owner crashed before reap) */
  emit_jsonf(AC_E_ERROR, "{\"command_id\":\"%s\",\"message\":\"owning-helper-unreaped\"}", command_id);
}

/* AC_R_CANCEL from a fresh session: refuse a fabricated proof when the fresh
 * run has no owning pgid and route the proof through the recorded group (B3). */
static void handle_cancel(struct ac_run *run, struct ac_frame *frame, int grace_ms) {
  char command_id[129];
  char workspace_id[128];
  if (json_value((const char *)frame->payload, "command_id", command_id, sizeof(command_id)) == NULL) {
    emit_jsonf(AC_E_CANCEL_UNKNOWN, "{\"command_id\":null,\"message\":\"missing-command-id\"}");
    return;
  }
  if (json_value((const char *)frame->payload, "workspace_id", workspace_id, sizeof(workspace_id)) == NULL) {
    workspace_id[0] = '\0';
  }
  if (run->live && run->pgid > 1 && strcmp(run->command_id, command_id) == 0) {
    (void)cancel_owned(run, grace_ms);
    return;
  }
  (void)cancel_cross(workspace_id, command_id, grace_ms);
}

static void reset_run(struct ac_run *run) {
  close_command_logs(run);
  free_argv(run->argv, run->argc);
  memset(run, 0, sizeof(*run));
  run->stdout_fd = -1;
  run->stderr_fd = -1;
  run->stdin_fd = -1;
  run->tty_fd = -1;
}

static void serve(void) {
  struct ac_run run;
  memset(&run, 0, sizeof(run));
  run.stdout_fd = -1;
  run.stderr_fd = -1;
  run.stdin_fd = -1;
  run.tty_fd = -1;
  for (;;) {
    struct ac_frame frame;
    if (read_frame(STDIN_FILENO, &frame) != 0) break;
    switch (frame.type) {
      case AC_R_HELLO:
        emit_jsonf(AC_E_HELLO_OK, "{\"protocol\":%d,\"helper_version\":\"%s\",\"helper_arch\":\"%s\",\"remote_boot_id\":\"%s\",\"helper_pid\":%ld}",
                   AC_HELPER_PROTOCOL_VERSION, AC_HELPER_VERSION, AC_HELPER_ARCH, g_boot_id, (long)getpid());
        break;
      case AC_R_EXEC: {
        reset_run(&run);
        if (json_value((const char *)frame.payload, "command_id", run.command_id, sizeof(run.command_id)) == NULL) {
          emit_jsonf(AC_E_REJECTED, "{\"command_id\":null,\"reason\":\"missing-command-id\"}");
          break;
        }
        json_value((const char *)frame.payload, "request_hash", run.request_hash, sizeof(run.request_hash));
        json_value((const char *)frame.payload, "workspace_id", run.workspace_id, sizeof(run.workspace_id));
        json_value((const char *)frame.payload, "mode", run.mode, sizeof(run.mode));
        if (run.mode[0] == '\0') strcpy(run.mode, "pipe");
        json_value((const char *)frame.payload, "cwd", run.workdir, sizeof(run.workdir));
        if (strcmp(run.workdir, "null") == 0) run.workdir[0] = '\0';
        int cols = 80;
        int rows = 24;
        char s[16];
        if (json_value((const char *)frame.payload, "cols", s, sizeof(s)) != NULL) {
          char *end = NULL;
          long v = strtol(s, &end, 10);
          if (end != s && v > 0 && v <= 8192) cols = (int)v;
        }
        if (json_value((const char *)frame.payload, "rows", s, sizeof(s)) != NULL) {
          char *end = NULL;
          long v = strtol(s, &end, 10);
          if (end != s && v > 0 && v <= 8192) rows = (int)v;
        }
        int grace_ms = 5000;
        if (json_value((const char *)frame.payload, "grace_ms", s, sizeof(s)) != NULL) {
          char *end = NULL;
          long v = strtol(s, &end, 10);
          if (end != s && v > 0 && v < 3600000) grace_ms = (int)v;
        }
        run.argc = parse_argv((const char *)frame.payload, run.argv, 256);
        if (run.argc <= 0 || run.argv[0] == NULL || run.argv[0][0] == '\0') {
          emit_jsonf(AC_E_REJECTED, "{\"command_id\":\"%s\",\"reason\":\"empty-argv\"}", run.command_id);
          break;
        }
        if (spawn_command(&run, strcmp(run.mode, "pty") == 0, cols, rows) != 0) break;
        int outcome = drive_exec(&run, grace_ms);
        if (outcome == 3) {
          /* transport loss → durable orphan pump (B4) */
          orphan_pump(&run);
        } else if (outcome == 1) {
          run.live = 0;
        }
        break;
      }
      case AC_R_ATTACH: {
        int grace_ms = 5000;
        char s[16];
        if (json_value((const char *)frame.payload, "grace_ms", s, sizeof(s)) != NULL) {
          char *end = NULL;
          long v = strtol(s, &end, 10);
          if (end != s && v > 0 && v < 3600000) grace_ms = (int)v;
        }
        handle_attach(&frame, grace_ms);
        break;
      }
      case AC_R_CANCEL: {
        int grace_ms = 5000;
        char s[16];
        if (json_value((const char *)frame.payload, "grace_ms", s, sizeof(s)) != NULL) {
          char *end = NULL;
          long v = strtol(s, &end, 10);
          if (end != s && v > 0 && v < 3600000) grace_ms = (int)v;
        }
        handle_cancel(&run, &frame, grace_ms);
        break;
      }
      default:
        emit_jsonf(AC_E_ERROR, "{\"command_id\":null,\"message\":\"unhandled\"}");
        break;
    }
    free_frame(&frame);
  }
  /* transport EOF: never SIGKILL the child (B4); hand off to the durable
   * orphan pump when a live command is still owned. */
  if (run.live) orphan_pump(&run);
  free_argv(run.argv, run.argc);
  close_command_logs(&run);
  return;
}

static void terminate_group(pid_t pgid, int sig) {
  if (pgid > 1) kill(-pgid, sig);
}

static int group_alive(pid_t pgid) {
  if (pgid <= 1) return 0;
  errno = 0;
  if (kill(-pgid, 0) == 0) return 1;
  return errno == EPERM;
}

int main(int argc, char **argv) {
  if (argc < 2) die("usage: agent-containers-helper <handshake|serve>\n");
  read_boot_id();
  if (strcmp(argv[1], "handshake") == 0) {
    printf("agent-containers-helper v%s protocol=%d arch=%s boot=%s\n",
           AC_HELPER_VERSION, AC_HELPER_PROTOCOL_VERSION, AC_HELPER_ARCH, g_boot_id);
    fflush(stdout);
    return 0;
  }
  if (strcmp(argv[1], "serve") != 0) die("unknown subcommand: %s\n", argv[1]);
  serve();
  (void)argc;
  return 0;
}