#include <node_api.h>

#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

napi_value String(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

void SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value boolean;
  napi_get_boolean(env, value, &boolean);
  Set(env, object, name, boolean);
}

std::string ArgumentString(napi_env env, napi_callback_info info, size_t index) {
  size_t argc = index + 1;
  std::vector<napi_value> args(argc);
  napi_get_cb_info(env, info, &argc, args.data(), nullptr, nullptr);
  if (argc <= index) {
    napi_throw_type_error(env, nullptr, "A path string is required.");
    return {};
  }
  napi_valuetype type;
  napi_typeof(env, args[index], &type);
  if (type != napi_string) {
    napi_throw_type_error(env, nullptr, "Path arguments must be strings.");
    return {};
  }
  size_t length = 0;
  napi_get_value_string_utf8(env, args[index], nullptr, 0, &length);
  std::vector<char> buffer(length + 1);
  napi_get_value_string_utf8(env, args[index], buffer.data(), buffer.size(), &length);
  return std::string(buffer.data(), length);
}

napi_value PathResult(napi_env env, bool ok, const std::string& path, const char* target, const char* method, const std::string& error = {}) {
  napi_value result;
  napi_create_object(env, &result);
  SetBool(env, result, "ok", ok);
  Set(env, result, "path", String(env, path));
  Set(env, result, "target", String(env, target));
  Set(env, result, "method", String(env, method));
  if (!error.empty()) Set(env, result, "error", String(env, error));
  return result;
}

napi_value MoveResult(napi_env env, bool ok, const std::string& source, const std::string& destination, const char* method, const std::string& error = {}, const char* code = nullptr, const char* windows_error = nullptr) {
  napi_value result;
  napi_create_object(env, &result);
  SetBool(env, result, "ok", ok);
  Set(env, result, "source", String(env, source));
  Set(env, result, "destination", String(env, destination));
  Set(env, result, "method", String(env, method));
  if (!error.empty()) Set(env, result, "error", String(env, error));
  if (code != nullptr) Set(env, result, "code", String(env, code));
  if (windows_error != nullptr) Set(env, result, "windowsError", String(env, windows_error));
  return result;
}

#ifdef _WIN32
std::wstring ToWide(const std::string& value) {
  const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(), static_cast<int>(value.size()), nullptr, 0);
  if (required == 0) return {};
  std::wstring result(required, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(), static_cast<int>(value.size()), &result[0], required);
  return result;
}

std::string WinError(DWORD error) {
  char buffer[256] = {};
  const DWORD count = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, error, 0, buffer, sizeof(buffer), nullptr);
  return count == 0 ? "Windows error " + std::to_string(error) : std::string(buffer, count);
}

std::string ToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (required == 0) return {};
  std::string result(required, '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(), static_cast<int>(value.size()), result.data(), required, nullptr, nullptr) == 0) return {};
  return result;
}
#endif

napi_value Capabilities(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
#ifdef _WIN32
  SetBool(env, result, "regularFileSync", true);
  SetBool(env, result, "directorySync", false);
  SetBool(env, result, "writeThroughMove", true);
#else
  SetBool(env, result, "regularFileSync", true);
  SetBool(env, result, "directorySync", true);
  SetBool(env, result, "writeThroughMove", false);
#endif
  return result;
}

napi_value SyncPath(napi_env env, napi_callback_info info) {
  const std::string path = ArgumentString(env, info, 0);
  if (path.empty()) return nullptr;
#ifdef _WIN32
  const std::wstring widePath = ToWide(path);
  if (widePath.empty()) return PathResult(env, false, path, "file", "flush-file-buffers", "Path is not valid UTF-8.");
  const DWORD attributes = GetFileAttributesW(widePath.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) return PathResult(env, false, path, "file", "flush-file-buffers", WinError(GetLastError()));
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    return PathResult(env, false, path, "directory", "unsupported", "Windows does not provide a per-directory durability guarantee.");
  }
  HANDLE handle = CreateFileW(widePath.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return PathResult(env, false, path, "file", "flush-file-buffers", WinError(GetLastError()));
  const bool ok = FlushFileBuffers(handle) != 0;
  const std::string error = ok ? "" : WinError(GetLastError());
  CloseHandle(handle);
  return PathResult(env, ok, path, "file", "flush-file-buffers", error);
#else
  struct stat status {};
  if (lstat(path.c_str(), &status) != 0) return PathResult(env, false, path, "file", "fsync", std::strerror(errno));
  const bool directory = S_ISDIR(status.st_mode);
  if (!directory && !S_ISREG(status.st_mode)) return PathResult(env, false, path, "file", "unsupported", "Only regular files and directories can be synchronized.");
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) return PathResult(env, false, path, directory ? "directory" : "file", directory ? "fsync" : "fsync", std::strerror(errno));
#ifdef __APPLE__
  const int result = directory ? fsync(fd) : fcntl(fd, F_FULLFSYNC);
  const char* method = directory ? "fsync" : "fullfsync";
#else
  const int result = fsync(fd);
  const char* method = "fsync";
#endif
  const std::string error = result == 0 ? "" : std::strerror(errno);
  close(fd);
  return PathResult(env, result == 0, path, directory ? "directory" : "file", method, error);
#endif
}

napi_value MoveFileWriteThrough(napi_env env, napi_callback_info info) {
  const std::string source = ArgumentString(env, info, 0);
  if (source.empty()) return nullptr;
  const std::string destination = ArgumentString(env, info, 1);
  if (destination.empty()) return nullptr;
#ifdef _WIN32
  const std::wstring wideSource = ToWide(source);
  const std::wstring wideDestination = ToWide(destination);
  if (wideSource.empty() || wideDestination.empty()) return MoveResult(env, false, source, destination, "move-file-write-through", "Paths are not valid UTF-8.");
  const bool ok = MoveFileExW(wideSource.c_str(), wideDestination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
  const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  const char* code = error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS ? "EEXIST" : nullptr;
  const char* windows_error = error == ERROR_ACCESS_DENIED ? "ERROR_ACCESS_DENIED" : nullptr;
  return MoveResult(env, ok, source, destination, "move-file-write-through", ok ? "" : WinError(error), code, windows_error);
#else
  return MoveResult(env, false, source, destination, "unsupported", "Write-through rename is only available through MoveFileExW on Windows.");
#endif
}

napi_value MoveFileNoReplaceWriteThrough(napi_env env, napi_callback_info info) {
  const std::string source = ArgumentString(env, info, 0);
  if (source.empty()) return nullptr;
  const std::string destination = ArgumentString(env, info, 1);
  if (destination.empty()) return nullptr;
#ifdef _WIN32
  const std::wstring wideSource = ToWide(source);
  const std::wstring wideDestination = ToWide(destination);
  if (wideSource.empty() || wideDestination.empty()) return MoveResult(env, false, source, destination, "move-file-write-through", "Paths are not valid UTF-8.");
  const bool ok = MoveFileExW(wideSource.c_str(), wideDestination.c_str(), MOVEFILE_WRITE_THROUGH) != 0;
  const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  const char* code = error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS ? "EEXIST" : nullptr;
  const char* windows_error = error == ERROR_ACCESS_DENIED ? "ERROR_ACCESS_DENIED" : nullptr;
  return MoveResult(env, ok, source, destination, "move-file-write-through", ok ? "" : WinError(error), code, windows_error);
#else
  return MoveResult(env, false, source, destination, "unsupported", "Write-through rename is only available through MoveFileExW on Windows.");
#endif
}

napi_value WindowsDirectory(napi_env env, napi_callback_info) {
#ifdef _WIN32
  std::vector<wchar_t> buffer(MAX_PATH);
  while (true) {
    const UINT length = GetWindowsDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
    if (length == 0) {
      napi_value undefined;
      napi_get_undefined(env, &undefined);
      return undefined;
    }
    if (length < buffer.size()) return String(env, ToUtf8(std::wstring(buffer.data(), length)));
    buffer.resize(static_cast<size_t>(length) + 1);
  }
#else
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
#endif
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"capabilities", nullptr, Capabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"syncPath", nullptr, SyncPath, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"moveFileWriteThrough", nullptr, MoveFileWriteThrough, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"moveFileNoReplaceWriteThrough", nullptr, MoveFileNoReplaceWriteThrough, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windowsDirectory", nullptr, WindowsDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
