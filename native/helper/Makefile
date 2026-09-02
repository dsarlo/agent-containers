# Reproducible build for the package-owned remote helper.
#
# Produces static Linux artifacts for linux-x64 and linux-arm64 into bin/ and
# pins them through scripts/build-helper.mjs --pin. The pinned digests are the
# manifest contract; a clean rebuild on a pinned toolchain must reproduce them.
#
# Toolchain:
#   CC        native compiler (defaults to cc; use musl-gcc for static glibc-free)
#   CC_ARM64  arm64 cross compiler (defaults to aarch64-linux-musl-gcc; a pinned
#             aarch64-linux-gnu-gcc works too, though it links glibc dynamically)
#   STATIC    1 (default) adds -static
#
# Cross compiling the arm64 artifact therefore requires a cross toolchain; the
# verify contract additionally accepts an artifact produced under an explicitly
# pinned docker build image (see scripts/build-helper.mjs and ci.yml).

CC ?= cc
CC_ARM64 ?= aarch64-linux-gnu-gcc
STATIC ?= 1

BIN_DIR := bin
HELPER_X64 := $(BIN_DIR)/agent-containers-helper-linux-x64
HELPER_ARM64 := $(BIN_DIR)/agent-containers-helper-linux-arm64

CFLAGS_FIXED := -std=c11 -O2 -fno-ident -ffile-prefix-map=$(CURDIR)=.
CFLAGS_WARN := -Wall -Wextra -Werror -Wno-unused-parameter
LDFLAGS_FIXED := -Wl,--build-id=none

ifeq ($(STATIC),1)
  STATIC_FLAG := -static
else
  STATIC_FLAG :=
endif

.PHONY: all x64 arm64 clean

all: $(HELPER_X64) $(HELPER_ARM64)

x64: $(HELPER_X64)
arm64: $(HELPER_ARM64)

$(HELPER_X64): helper.c
	@mkdir -p $(BIN_DIR)
	$(CC) $(CFLAGS_FIXED) $(CFLAGS_WARN) $(LDFLAGS_FIXED) $(STATIC_FLAG) -s -o $@ helper.c

$(HELPER_ARM64): helper.c
	@mkdir -p $(BIN_DIR)
	$(CC_ARM64) $(CFLAGS_FIXED) $(CFLAGS_WARN) $(LDFLAGS_FIXED) $(STATIC_FLAG) -s -o $@ helper.c

clean:
	rm -rf $(BIN_DIR)