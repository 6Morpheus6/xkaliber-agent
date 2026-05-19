#!/bin/bash
set -e

APP_NAME="xagent"
VERSION="38.0.0"
ARCH="amd64"
DEB_NAME="${APP_NAME}_${VERSION}_${ARCH}"

# Create directories
mkdir -p build/$DEB_NAME/usr/bin
mkdir -p build/$DEB_NAME/usr/lib/$APP_NAME
mkdir -p build/$DEB_NAME/DEBIAN

# Copy source files
cp package.json index.js memory.js tools.js build/$DEB_NAME/usr/lib/$APP_NAME/

# Create wrapper script
cat << 'EOF' > build/$DEB_NAME/usr/bin/$APP_NAME
#!/bin/bash
export NODE_ENV=production
node /usr/lib/xagent/index.js "$@"
EOF
chmod +x build/$DEB_NAME/usr/bin/$APP_NAME

# Create DEBIAN/control file
cat << EOF > build/$DEB_NAME/DEBIAN/control
Package: $APP_NAME
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Depends: nodejs (>= 18.0.0)
Maintainer: Legend
Description: Xkaliber Agent CLI
 A powerful autonomous CLI agent optimized for AMD and local Ollama.
EOF

# Build the .deb
dpkg-deb --build build/$DEB_NAME

echo "Successfully built build/${DEB_NAME}.deb"
