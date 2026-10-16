#!/bin/sh
# Setup of SynthOrg's own WSL distro (synthorg-pods): podman never runs as
# root, and the distro never sees the Windows disk.
#
# SynthOrg runs this itself, right after it imports the distro from the Alpine
# archive of its base image (sandbox.js, ensureRuntimeDistro), and again if a
# start finds the setup unfinished. It is idempotent: a second run changes
# nothing already in place.
#
#   - podman and what it runs with (crun, fuse-overlayfs, netavark,
#     aardvark-dns, pasta) come from Alpine's own repositories, the branch of
#     the Alpine the archive is;
#   - the distro carries SynthOrg's mark (/etc/synthorg-pods): only a distro
#     with it is ever used by the app, one without it is never touched;
#   - podman runs as the unprivileged user `synthorg`, with a subordinate id
#     range, so every container has its own user namespace and a container's
#     root is not the user;
#   - a cgroup is delegated to that user at every boot, so the memory, CPU and
#     process limits of the containers apply without systemd;
#   - the Windows drives are not mounted at all; the one entry point
#     (`synthorg-podman`) mounts SynthOrg's own data folder, and nothing else,
#     readable by that user alone, when the caller names it.
set -eu

branch="v$(cut -d. -f1,2 /etc/alpine-release)"
printf '%s\n' "https://dl-cdn.alpinelinux.org/alpine/$branch/main" "https://dl-cdn.alpinelinux.org/alpine/$branch/community" > /etc/apk/repositories
# iptables: what netavark builds a container's bridge network with (the build network, a chat's or a project's own).
apk add --no-cache podman crun fuse-overlayfs netavark aardvark-dns passt iptables ip6tables su-exec shadow-subids >/dev/null

if [ ! -f /etc/synthorg-pods ]; then
  printf '{"app":"org.synthorg.orchestrator","what":"il disco dei pod di SynthOrg","alpine":"%s","made":"%s"}\n' "$(cat /etc/alpine-release)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /etc/synthorg-pods
fi

if ! id synthorg >/dev/null 2>&1; then
  adduser -D -h /home/synthorg -u 1000 synthorg
fi
grep -q '^synthorg:' /etc/subuid || echo 'synthorg:100000:65536' >> /etc/subuid
grep -q '^synthorg:' /etc/subgid || echo 'synthorg:100000:65536' >> /etc/subgid

mkdir -p /home/synthorg/.config/containers /home/synthorg/.local/share/containers
cat > /home/synthorg/.config/containers/containers.conf <<'EOF'
[containers]
default_sysctls = ["net.ipv4.ping_group_range=0 0"]
[engine]
runtime = "crun"
cgroup_manager = "cgroupfs"
events_logger = "file"
[network]
default_rootless_network_cmd = "pasta"
EOF
# fuse-overlayfs: the only overlay that lets a rootless container remap the
# image's ownership into its own user namespace on this kernel
cat > /home/synthorg/.config/containers/storage.conf <<'EOF'
[storage]
driver = "overlay"
[storage.options.overlay]
mount_program = "/usr/bin/fuse-overlayfs"
EOF
chown -R synthorg:synthorg /home/synthorg
chmod 700 /home/synthorg

cat > /usr/local/bin/synthorg-runtime-boot <<'EOF'
#!/bin/sh
# Prepares the distro for the unprivileged podman user. Safe to run again.
mkdir -p /run/user/1000 && chown synthorg:synthorg /run/user/1000 && chmod 700 /run/user/1000
# A cgroup of our own with the controllers enabled for its children: every
# podman call runs in a leaf under it, and crun creates the containers'
# cgroups beside that leaf, with the limits podman asks for.
CG=/sys/fs/cgroup
echo "+cpu +cpuset +io +memory +pids" > "$CG/cgroup.subtree_control" 2>/dev/null || true
mkdir -p "$CG/synthorg"
echo "+cpu +cpuset +io +memory +pids" > "$CG/synthorg/cgroup.subtree_control" 2>/dev/null || true
chown synthorg:synthorg "$CG/synthorg" "$CG/synthorg/cgroup.procs" 2>/dev/null || true
EOF
chmod 755 /usr/local/bin/synthorg-runtime-boot

cat > /usr/local/bin/synthorg-podman <<'EOF'
#!/bin/sh
# podman for SynthOrg: never root. Runs as user synthorg, inside its cgroup.
/usr/local/bin/synthorg-runtime-boot
CG=/sys/fs/cgroup/synthorg
leaf="$CG/${SYNTHORG_CGROUP:-cli}"
mkdir -p "$leaf"
echo $$ > "$leaf/cgroup.procs" 2>/dev/null || true
cd /home/synthorg
# SynthOrg's data folder, and nothing else of the Windows disk: for the user only.
if [ -n "${SYNTHORG_DATA_WIN:-}" ]; then
  mkdir -p /mnt/synthorg-data
  if ! mountpoint -q /mnt/synthorg-data; then
    mount -t drvfs "$SYNTHORG_DATA_WIN" /mnt/synthorg-data -o "uid=1000,gid=1000,umask=077,metadata" 2>/dev/null \
      || mount -t drvfs "$SYNTHORG_DATA_WIN" /mnt/synthorg-data -o "uid=1000,gid=1000,umask=077" || true
  fi
fi
export USER=synthorg LOGNAME=synthorg HOME=/home/synthorg XDG_RUNTIME_DIR=/run/user/1000 XDG_CONFIG_HOME=/home/synthorg/.config XDG_DATA_HOME=/home/synthorg/.local/share
exec su-exec synthorg:synthorg podman "$@"
EOF
chmod 755 /usr/local/bin/synthorg-podman

cat > /etc/wsl.conf <<'EOF'
# SynthOrg's own distro (org.synthorg.orchestrator): the pods' disk. Managed by the app.
[automount]
enabled = false
[interop]
enabled = false
appendWindowsPath = false
[boot]
command = "/usr/local/bin/synthorg-runtime-boot"
EOF

/usr/local/bin/synthorg-runtime-boot
echo "rootless setup ok"
