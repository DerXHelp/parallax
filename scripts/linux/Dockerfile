# Linux test environment for Parallax (WP-100 E8, WP-101) – never part of a release.
#
# Build (context = this folder only, no repo files go into the image):
#   docker build -t parallax-linux:24.04 --build-arg UBUNTU=24.04 scripts/linux
#   docker build -t parallax-linux:24.04-systemd --target systemd --build-arg UBUNTU=24.04 scripts/linux
# Run with limits (ADR-154): see scripts/linux/README.md.
ARG UBUNTU=24.04

FROM ubuntu:${UBUNTU} AS common
ARG NODE_VERSION=26.12.0
ARG PNPM_VERSION=12.17.0
ARG CHROME=1
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# util-linux: setsid -c (PTY spike); procps: ps/pgrep for checks; dbus + gnome-keyring + libsecret: Secret Service
# spike; libnotify-bin: notify-send flags; xz-utils: Node tarball; libatomic1: needed by the official Node 26 build
# (missing on minimal Ubuntu installs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git util-linux procps libatomic1 \
      dbus dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools libnotify-bin \
 && rm -rf /var/lib/apt/lists/*

# Official Node build (bundles OpenSSL 3.5, which "Mehrere Rechner" needs; the Ubuntu package is too old).
RUN set -eux; \
    case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac; \
    base="https://nodejs.org/dist/v${NODE_VERSION}"; \
    file="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLO "${base}/${file}"; \
    curl -fsSL "${base}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c -; \
    tar -xJf "${file}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "${file}"; \
    node --version; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    pnpm --version

# Google Chrome for E2E (Playwright channel 'chrome'); skip with --build-arg CHROME=0.
RUN set -eux; \
    if [ "${CHROME}" = "1" ]; then \
      curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; \
      apt-get update; \
      apt-get install -y --no-install-recommends /tmp/chrome.deb; \
      rm -rf /var/lib/apt/lists/* /tmp/chrome.deb; \
    fi

# Unprivileged user like a normal desktop account (the image may already have "ubuntu" with uid 1000).
RUN id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu
USER ubuntu
WORKDIR /home/ubuntu

# systemd as PID 1 – only for the systemd-creds / linger / user-service spikes (needs --privileged).
FROM common AS systemd
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus-user-session libpam-systemd \
 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

# Default target (the last stage): the unprivileged image (user "ubuntu" from `common`). Run it with `--init` so that
# orphaned processes are reaped (otherwise they stay zombies under PID 1 and look alive to kill(pid, 0)).
FROM common AS base
