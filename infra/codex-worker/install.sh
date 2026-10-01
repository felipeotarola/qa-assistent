#!/bin/sh
# Root-only installation of the trusted controller; never run repo code here.
set -eu
version=0.159.3
target=/opt/qa-codex/$version
test "$(uname -m)" = x86_64 || { echo 'This pinned package requires x86_64'; exit 1; }
install -d -m 755 "$target"
curl -fsSL "https://registry.npmjs.org/@openai/codex/-/codex-$version-linux-x64.tgz" -o "$target/package.tgz"
actual=$(openssl dgst -sha512 -binary "$target/package.tgz" | openssl base64 -A)
test "$actual" = 'xlHydfOksnNt/qz4BEVFvjMWunweaVSNtha/DkVUwWZnVZxbqiJwsXSl2iZDk04b6k/g0OI7jU06XqzHB2s5og==' || { echo 'Package integrity mismatch'; exit 1; }
tar -xzf "$target/package.tgz" -C "$target"
id qa-codex >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/qa-codex --shell /usr/sbin/nologin qa-codex
chmod 700 /var/lib/qa-codex
install -d -o qa-codex -g qa-codex -m 700 /var/lib/qa-codex/.codex /var/lib/qa-codex/control
ln -sfn "$target/package/vendor/x86_64-unknown-linux-musl/bin/codex" /opt/qa-codex/codex
/opt/qa-codex/codex --version
echo 'Run interactively: runuser -u qa-codex -- /opt/qa-codex/codex login --device-auth'
