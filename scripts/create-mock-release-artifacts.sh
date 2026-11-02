#!/usr/bin/env bash

set -euo pipefail

ARTIFACTS_DIR="${1:-build-artifacts}"

write_mock_installer() {
  local output="$1"
  printf 'mock installer bytes for %s\n' "$(basename "$output")" > "$output"
}

rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR/windows-build-x64"
mkdir -p "$ARTIFACTS_DIR/windows-build-arm64"
mkdir -p "$ARTIFACTS_DIR/macos-build-x64"
mkdir -p "$ARTIFACTS_DIR/macos-build-arm64"
mkdir -p "$ARTIFACTS_DIR/linux-build-x64"
mkdir -p "$ARTIFACTS_DIR/linux-build-arm64"

# Windows x64
write_mock_installer "$ARTIFACTS_DIR/windows-build-x64/OpenH3-1.0.0-win-x64.exe"
cat > "$ARTIFACTS_DIR/windows-build-x64/latest.yml" <<'EOF'
version: 1.0.0
files:
  - url: OpenH3-1.0.0-win-x64.exe
    sha512: fake-sha512-x64
    size: 100000
path: OpenH3-1.0.0-win-x64.exe
sha512: fake-sha512-x64
releaseDate: '2025-01-01'
EOF

# Windows arm64
write_mock_installer "$ARTIFACTS_DIR/windows-build-arm64/OpenH3-1.0.0-win-arm64.exe"
cat > "$ARTIFACTS_DIR/windows-build-arm64/latest.yml" <<'EOF'
version: 1.0.0
files:
  - url: OpenH3-1.0.0-win-arm64.exe
    sha512: fake-sha512-arm64
    size: 100000
path: OpenH3-1.0.0-win-arm64.exe
sha512: fake-sha512-arm64
releaseDate: '2025-01-01'
EOF

# macOS x64
write_mock_installer "$ARTIFACTS_DIR/macos-build-x64/OpenH3-1.0.0-mac-x64.dmg"
write_mock_installer "$ARTIFACTS_DIR/macos-build-x64/OpenH3-1.0.0-mac-x64.zip"
cat > "$ARTIFACTS_DIR/macos-build-x64/latest-mac.yml" <<'EOF'
version: 1.0.0
files:
  - url: OpenH3-1.0.0-mac-x64.dmg
    sha512: fake-sha512-mac-x64
    size: 200000
EOF

# macOS arm64
write_mock_installer "$ARTIFACTS_DIR/macos-build-arm64/OpenH3-1.0.0-mac-arm64.dmg"
write_mock_installer "$ARTIFACTS_DIR/macos-build-arm64/OpenH3-1.0.0-mac-arm64.zip"
cat > "$ARTIFACTS_DIR/macos-build-arm64/latest-mac.yml" <<'EOF'
version: 1.0.0
files:
  - url: OpenH3-1.0.0-mac-arm64.dmg
    sha512: fake-sha512-mac-arm64
    size: 200000
EOF

# Linux x64
write_mock_installer "$ARTIFACTS_DIR/linux-build-x64/OpenH3-1.0.0.deb"
cat > "$ARTIFACTS_DIR/linux-build-x64/latest-linux.yml" <<'EOF'
version: 1.0.0
files:
  - url: OpenH3-1.0.0.deb
    sha512: fake-sha512-linux
    size: 300000
EOF

# Linux arm64
write_mock_installer "$ARTIFACTS_DIR/linux-build-arm64/OpenH3-1.0.0-arm64.deb"
cat > "$ARTIFACTS_DIR/linux-build-arm64/latest-linux-arm64.yml" <<'EOF'
version: 1.0.0
files:
  - url: OpenH3-1.0.0-arm64.deb
    sha512: fake-sha512-linux-arm64
    size: 300000
EOF

# Web-CLI tarballs (5 platforms)
WEB_PLATFORMS=(
  "darwin-arm64"
  "darwin-x86_64"
  "linux-arm64"
  "linux-x86_64"
  "win-x86_64"
)

for plat in "${WEB_PLATFORMS[@]}"; do
  dir="$ARTIFACTS_DIR/web-cli-${plat}"
  mkdir -p "$dir"
  tarball="openh3-web-1.0.0-${plat}.tar.gz"
  touch "$dir/$tarball"
  # Produce a deterministic fake SHA256 file in the expected format:
  # "<64 hex chars>  <filename>"
  echo "0000000000000000000000000000000000000000000000000000000000000000  ${tarball}" > "$dir/${tarball}.sha256"
done

# install-web.sh (version-substituted placeholder)
mkdir -p "$ARTIFACTS_DIR/install-web-script"
cat > "$ARTIFACTS_DIR/install-web-script/install-web.sh" <<'EOF'
#!/usr/bin/env bash
# Mock install-web.sh for release-script-test
set -euo pipefail
echo "mock install-web.sh"
EOF
chmod +x "$ARTIFACTS_DIR/install-web-script/install-web.sh"

refresh_mock_metadata() {
  local manifest="$1"
  local installer="$2"
  local installer_path="$ARTIFACTS_DIR/$installer"
  local size
  local sha512
  size=$(wc -c < "$installer_path" | tr -d '[:space:]')
  sha512=$(openssl dgst -sha512 -binary "$installer_path" | base64 | tr -d '\r\n')
  sed -i "s|fake-sha512-[^[:space:]]*|$sha512|g; s|size: [0-9]*|size: $size|" "$ARTIFACTS_DIR/$manifest"
}

refresh_mock_metadata "windows-build-x64/latest.yml" "windows-build-x64/OpenH3-1.0.0-win-x64.exe"
refresh_mock_metadata "windows-build-arm64/latest.yml" "windows-build-arm64/OpenH3-1.0.0-win-arm64.exe"
refresh_mock_metadata "macos-build-x64/latest-mac.yml" "macos-build-x64/OpenH3-1.0.0-mac-x64.dmg"
refresh_mock_metadata "macos-build-arm64/latest-mac.yml" "macos-build-arm64/OpenH3-1.0.0-mac-arm64.dmg"
refresh_mock_metadata "linux-build-x64/latest-linux.yml" "linux-build-x64/OpenH3-1.0.0.deb"
refresh_mock_metadata "linux-build-arm64/latest-linux-arm64.yml" "linux-build-arm64/OpenH3-1.0.0-arm64.deb"

for arch in x64 arm64; do
  zip_name="OpenH3-1.0.0-mac-${arch}.zip"
  zip_path="$ARTIFACTS_DIR/macos-build-${arch}/$zip_name"
  zip_size=$(wc -c < "$zip_path" | tr -d '[:space:]')
  zip_hash=$(openssl dgst -sha512 -binary "$zip_path" | base64 | tr -d '\r\n')
  cat >> "$ARTIFACTS_DIR/macos-build-${arch}/latest-mac.yml" <<EOF
  - url: $zip_name
    sha512: $zip_hash
    size: $zip_size
EOF
done

echo "Mock artifacts created in $ARTIFACTS_DIR:"
find "$ARTIFACTS_DIR" -type f | sort
