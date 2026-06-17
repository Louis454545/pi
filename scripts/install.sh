#!/usr/bin/env sh
set -eu

APP_NAME="${MORGAN_INSTALL_APP_NAME:-morgan}"
REPO="${MORGAN_INSTALL_REPO:-earendil-works/morgan}"
INSTALL_DIR="${MORGAN_INSTALL_DIR:-"$HOME/.local/share/morgan/current"}"
BIN_DIR="${MORGAN_INSTALL_BIN_DIR:-"$HOME/.local/bin"}"
INSTALLER_URL="${MORGAN_INSTALLER_URL:-https://morgan.dev/install.sh}"
BASE_URL="${MORGAN_INSTALL_BASE_URL:-https://github.com/$REPO/releases/latest/download}"

fail() {
	printf '%s\n' "error: $*" >&2
	exit 1
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

detect_platform() {
	os="$(uname -s 2>/dev/null || printf unknown)"
	arch="$(uname -m 2>/dev/null || printf unknown)"

	if [ -n "${ANDROID_ROOT:-}" ] || [ -n "${TERMUX_VERSION:-}" ]; then
		fail "Termux/Android is not supported by the standalone binary installer. See docs/termux.md."
	fi

	case "$os" in
		Darwin) os_part="darwin" ;;
		Linux) os_part="linux" ;;
		MINGW*|MSYS*|CYGWIN*|Windows_NT) fail "Use the Windows archive from GitHub Releases. The POSIX installer does not support Windows." ;;
		*) fail "unsupported OS: $os" ;;
	esac

	case "$arch" in
		x86_64|amd64) arch_part="x64" ;;
		arm64|aarch64) arch_part="arm64" ;;
		*) fail "unsupported CPU architecture: $arch" ;;
	esac

	printf '%s-%s' "$os_part" "$arch_part"
}

sha256_file() {
	file="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | awk '{print $1}'
		return
	fi
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$file" | awk '{print $1}'
		return
	fi
	fail "sha256sum or shasum is required"
}

shell_quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

download() {
	url="$1"
	output="$2"
	curl -fL --proto '=https' --tlsv1.2 "$url" -o "$output"
}

platform="$(detect_platform)"
archive="${APP_NAME}-${platform}.tar.gz"
archive_url="$BASE_URL/$archive"
checksums_url="$BASE_URL/SHA256SUMS"

if [ "${MORGAN_INSTALL_DRY_RUN:-0}" = "1" ]; then
	printf 'platform=%s\n' "$platform"
	printf 'archive=%s\n' "$archive"
	printf 'archive_url=%s\n' "$archive_url"
	printf 'checksums_url=%s\n' "$checksums_url"
	printf 'install_dir=%s\n' "$INSTALL_DIR"
	printf 'bin_dir=%s\n' "$BIN_DIR"
	exit 0
fi

need_cmd curl
need_cmd tar
need_cmd awk
need_cmd sed

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/morgan-install.XXXXXX")"
cleanup() {
	rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

printf 'Downloading %s...\n' "$archive"
download "$archive_url" "$tmp_dir/$archive"
download "$checksums_url" "$tmp_dir/SHA256SUMS"

expected="$(awk -v file="$archive" '$2 == file {print $1}' "$tmp_dir/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS does not contain $archive"
actual="$(sha256_file "$tmp_dir/$archive")"
[ "$actual" = "$expected" ] || fail "checksum mismatch for $archive"

tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
[ -x "$tmp_dir/morgan/morgan" ] || fail "archive did not contain an executable morgan binary"

json_repo="$(json_escape "$REPO")"
json_installer_url="$(json_escape "$INSTALLER_URL")"
json_install_dir="$(json_escape "$INSTALL_DIR")"
json_bin_dir="$(json_escape "$BIN_DIR")"
json_archive="$(json_escape "$archive")"
cat >"$tmp_dir/morgan/install.json" <<EOF
{
  "installMethod": "installer-binary",
  "repo": "$json_repo",
  "installerUrl": "$json_installer_url",
  "installDir": "$json_install_dir",
  "binDir": "$json_bin_dir",
  "archive": "$json_archive"
}
EOF

parent_dir="$(dirname "$INSTALL_DIR")"
mkdir -p "$parent_dir" "$BIN_DIR"
rm -rf "$INSTALL_DIR.new"
mv "$tmp_dir/morgan" "$INSTALL_DIR.new"
rm -rf "$INSTALL_DIR.old"
if [ -e "$INSTALL_DIR" ]; then
	mv "$INSTALL_DIR" "$INSTALL_DIR.old"
fi
mv "$INSTALL_DIR.new" "$INSTALL_DIR"
rm -rf "$INSTALL_DIR.old"
launcher_path="$BIN_DIR/morgan"
{
	printf '#!/usr/bin/env sh\n'
	printf 'exec %s "$@"\n' "$(shell_quote "$INSTALL_DIR/morgan")"
} >"$launcher_path"
chmod +x "$launcher_path"

case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) printf 'Add %s to PATH to run morgan from a new shell.\n' "$BIN_DIR" ;;
esac

printf 'Installed morgan to %s\n' "$INSTALL_DIR"

if [ -t 0 ] && [ -t 1 ] && [ "${MORGAN_INSTALL_NO_SETUP:-0}" != "1" ]; then
	exec "$BIN_DIR/morgan" setup
fi

printf 'Run: %s/morgan setup\n' "$BIN_DIR"
