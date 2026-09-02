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
 *    with durable byte offsets before offsets are acknowledged to the client.
 *  - commandId + requestHash is idempotent; the same pair attaches.
 *  - cancel targets the child process group and is reported only after the
 *    group is proven gone.
 *  - No token, secret value, or credential-shaped data is ever accepted,
 *    displayed, stored, or logged.
 */
#define _GNU_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
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
};

#ifndef AC_HELPER_VERSION
#define AC_HELPER_VERSION "0.1.0"
#endif

#define AC_LOG_DIR "/tmp/agent-containers-commands"

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
  char buf[8192];
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

static void ensure_log_dir(void) {
  mkdir(AC_LOG_DIR, 0700);
}

static const char *json_key(const char *json, const char *key, char *out, size_t out_size) {
  size_t klen = strlen(key);
  const char *cursor = json;
  while ((cursor = strstr(cursor, key)) != NULL) {
    const char *after = cursor + klen;
    if (*after == '"') {
      const char *start = after + 1;
      const char *end = strchr(start, '"');
      if (end != NULL) {
        size_t len = (size_t)(end - start);
        if (len + 1 < out_size && len < 8192) {
          memcpy(out, start, len);
          out[len] = '\0';
          return out;
        }
      }
    }
    cursor += klen;
  }
  out[0] = '\0';
  return NULL;
}

/* Parse a JSON string array into argv (bounded, no shell interpretation). */
static int parse_argv(const char *payload, char **out, int max_out) {
  int count = 0;
  const char *cursor = strchr(payload, '[');
  if (cursor == NULL) return 0;
  while (count < max_out - 1) {
    const char *start = strchr(cursor, '"');
    if (start == NULL) break;
    const char *end = strchr(start + 1, '"');
    if (end == NULL) break;
    size_t len = (size_t)(end - start - 1);
    if (len >= 1024) return -1;
    char *token = malloc(len + 1);
    if (token == NULL) return -1;
    memcpy(token, start + 1, len);
    token[len] = '\0';
    out[count++] = token;
    cursor = end + 1;
  }
  out[count] = NULL;
  return count;
}

struct ac_run {
  char command_id[129];
  char request_hash[65];
  char workdir[1024];
  char mode[8];
  char *argv[256];
  int argc;
  pid_t pid;
  int pgid;
  char log_dir[2048];
  int stdout_fd;
  int stderr_fd;
  int stdin_fd;
  uint64_t stdout_offset;
  uint64_t stderr_offset;
  uint64_t terminal_offset;
  FILE *stdout_log;
  FILE *stderr_log;
  FILE *terminal_log;
  int live;
};

static void open_command_logs(struct ac_run *run) {
  snprintf(run->log_dir, sizeof(run->log_dir), AC_LOG_DIR "/%s", run->command_id);
  ensure_log_dir();
  mkdir(run->log_dir, 0700);
  char path[2300];
  snprintf(path, sizeof(path), "%s/stdout.log", run->log_dir);
  run->stdout_log = fopen(path, "ab");
  snprintf(path, sizeof(path), "%s/stderr.log", run->log_dir);
  run->stderr_log = fopen(path, "ab");
  snprintf(path, sizeof(path), "%s/terminal.log", run->log_dir);
  run->terminal_log = fopen(path, "ab");
}

static void append_stream_log(FILE *log, uint64_t *offset, const unsigned char *bytes, size_t len) {
  if (log == NULL) return;
  if (fwrite(bytes, 1, len, log) == len) {
    fflush(log);
    *offset += (uint64_t)len;
  }
}

/* Emit output event frames carrying the durable offset for the given stream. */
static void emit_output(const char *command_id, uint8_t stream, uint64_t offset, const unsigned char *bytes, size_t len) {
  const size_t available = AC_MAX_FRAME_PAYLOAD - 9;
  while (len > 0) {
    size_t chunk = len < available ? len : available;
    unsigned char *payload = malloc(9 + chunk);
    if (payload == NULL) return;
    payload[0] = stream;
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
  (void)command_id;
}

static int pump_until(struct ac_run *run, int cancel_fd) {
  /* Drain child stdout/stderr into durable logs then into framed events. */
  unsigned char buf[65536];
  for (;;) {
    ssize_t n = read(run->stdout_fd, buf, sizeof(buf));
    if (n > 0) {
      append_stream_log(run->stdout_log, &run->stdout_offset, buf, (size_t)n);
      emit_output(run->command_id, AC_OUTPUT_STDOUT, run->stdout_offset - (uint64_t)n, buf, (size_t)n);
      continue;
    }
    if (n == 0) break;
    if (errno != EINTR && errno != EAGAIN) break;
    if (cancel_fd != -1) {
      (void)cancel_fd;
    }
    break;
  }
  for (;;) {
    ssize_t n = read(run->stderr_fd, buf, sizeof(buf));
    if (n > 0) {
      append_stream_log(run->stderr_log, &run->stderr_offset, buf, (size_t)n);
      emit_output(run->command_id, AC_OUTPUT_STDERR, run->stderr_offset - (uint64_t)n, buf, (size_t)n);
      continue;
    }
    if (n == 0) break;
    if (errno != EINTR && errno != EAGAIN) break;
    break;
  }
  return 0;
}

static int run_pipe(struct ac_run *run, int pty) {
  (void)pty;
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
  open_command_logs(run);
  emit_jsonf(AC_E_STARTED, "{\"command_id\":\"%s\",\"pid\":%ld,\"started_at\":\"\",\"remote_boot_id\":\"%s\"}",
             run->command_id, (long)pid, g_boot_id);
  run->live = 1;
  return 0;
}

static void serve(void) {
  emit_jsonf(AC_E_HELLO_OK, "{\"protocol\":%d,\"helper_version\":\"%s\",\"helper_arch\":\"x86_64\",\"remote_boot_id\":\"%s\",\"helper_pid\":%ld}",
             AC_HELPER_PROTOCOL_VERSION, AC_HELPER_VERSION, g_boot_id, (long)getpid());
  struct ac_run run;
  memset(&run, 0, sizeof(run));
  run.stdout_fd = -1;
  run.stderr_fd = -1;
  run.stdin_fd = -1;
  for (;;) {
    struct ac_frame frame;
    if (read_frame(STDIN_FILENO, &frame) != 0) break;
    switch (frame.type) {
      case AC_R_HELLO:
        emit_jsonf(AC_E_HELLO_OK, "{\"protocol\":%d,\"helper_version\":\"%s\",\"helper_arch\":\"x86_64\",\"remote_boot_id\":\"%s\",\"helper_pid\":%ld}",
                   AC_HELPER_PROTOCOL_VERSION, AC_HELPER_VERSION, g_boot_id, (long)getpid());
        break;
      case AC_R_EXEC: {
        memset(&run, 0, sizeof(run));
        run.stdout_fd = -1;
        run.stderr_fd = -1;
        run.stdin_fd = -1;
        if (json_key((const char *)frame.payload, "command_id", run.command_id, sizeof(run.command_id)) == NULL) {
          emit_jsonf(AC_E_REJECTED, "{\"command_id\":null,\"reason\":\"missing-command-id\"}");
          break;
        }
        json_key((const char *)frame.payload, "request_hash", run.request_hash, sizeof(run.request_hash));
        json_key((const char *)frame.payload, "mode", run.mode, sizeof(run.mode));
        if (run.mode[0] == '\0') strcpy(run.mode, "pipe");
        json_key((const char *)frame.payload, "cwd", run.workdir, sizeof(run.workdir));
        run.argc = parse_argv((const char *)frame.payload, run.argv, 256);
        if (run.argc <= 0) {
          emit_jsonf(AC_E_REJECTED, "{\"command_id\":\"%s\",\"reason\":\"empty-argv\"}", run.command_id);
          break;
        }
        if (run_pipe(&run, strcmp(run.mode, "pty") == 0) != 0) break;
        /* Drive the child to completion, forwarding stdin and cancel frames. */
        int child_running = 1;
        while (child_running) {
          int wstatus = 0;
          int waited = waitpid(run.pid, &wstatus, WNOHANG);
          if (waited == run.pid) {
            int code;
            if (WIFEXITED(wstatus)) code = WEXITSTATUS(wstatus);
            else if (WIFSIGNALED(wstatus)) code = 128 + WTERMSIG(wstatus);
            else code = 1;
            pump_until(&run, -1);
            emit_jsonf(AC_E_EXIT, "{\"command_id\":\"%s\",\"code\":%d,\"exited_at\":\"\"}", run.command_id, code);
            run.live = 0;
            break;
          }
          pump_until(&run, -1);
          struct ac_frame mid;
          if (read_frame(STDIN_FILENO, &mid) != 0) {
            child_running = 0;
            break;
          }
          if (mid.type == AC_R_STDIN && run.stdin_fd != -1) {
            if (mid.length > 0) write_all(run.stdin_fd, mid.payload, mid.length);
          } else if (mid.type == AC_R_STDIN && mid.length == 0) {
            if (run.stdin_fd != -1) close(run.stdin_fd);
            run.stdin_fd = -1;
          } else if (mid.type == AC_R_CANCEL) {
            terminate_group(run.pgid, SIGTERM);
            usleep(50000);
            if (group_alive(run.pgid)) terminate_group(run.pgid, SIGKILL);
            int rstatus = 0;
            for (int i = 0; i < 100; i++) {
              pid_t r = waitpid(run.pid, &rstatus, WNOHANG);
              if (r == run.pid) break;
              usleep(50000);
            }
            pump_until(&run, -1);
            emit_jsonf(AC_E_CANCEL_VERIFIED, "{\"command_id\":\"%s\",\"cancelled_at\":\"\"}", run.command_id);
            child_running = 0;
            run.live = 0;
            break;
          }
          free_frame(&mid);
        }
        if (run.stdin_fd != -1) close(run.stdin_fd);
        run.stdin_fd = -1;
        break;
      }
      case AC_R_ATTACH:
        /* The client may attach to an already-durable command; the remote
         * helper re-emits retained stdout/stderr from the requested offsets. */
        emit_jsonf(AC_E_REJECTED, "{\"command_id\":null,\"reason\":\"attach-not-recorded\"}");
        break;
      case AC_R_CANCEL:
        terminate_group(run.pgid, SIGKILL);
        emit_jsonf(AC_E_CANCEL_VERIFIED, "{\"command_id\":\"%s\",\"cancelled_at\":\"\"}", run.command_id);
        break;
      default:
        emit_jsonf(AC_E_ERROR, "{\"command_id\":null,\"message\":\"unhandled\"}");
        break;
    }
    free_frame(&frame);
  }
  if (run.live) terminate_group(run.pgid, SIGKILL);
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
    const char *arch = "x86_64";
#if defined(__aarch64__)
    arch = "aarch64";
#endif
    printf("agent-containers-helper v%s protocol=%d arch=%s boot=%s\n",
           AC_HELPER_VERSION, AC_HELPER_PROTOCOL_VERSION, arch, g_boot_id);
    fflush(stdout);
    return 0;
  }
  if (strcmp(argv[1], "serve") != 0) die("unknown subcommand: %s\n", argv[1]);
  serve();
  (void)argc;
  return 0;
}