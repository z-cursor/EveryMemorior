# Pi Web Skill runtime

Build this image once on a provisioning host or in an isolated builder, then
preload the resulting image into the Docker host that runs Pi Web. Skill
containers use this image with `--network=none`; they do not install packages
or pull images during a run.

```sh
docker build -t pi-web-skill-runtime:2026-09-28 docker/skill-runtime
docker save pi-web-skill-runtime:2026-09-28 -o pi-web-skill-runtime.tar
# On the air-gapped host:
docker load -i pi-web-skill-runtime.tar
```

The image includes Node 22, Python 3, and the base dependency used by the
biography Skill. A tenant release with additional lockfiles is built by the
server-owned asynchronous runtime builder before publication. The builder
creates a derived image from this preloaded base, records its image and
lockfile digests, and caches it by release/profile. Agent execution never
pulls an image or installs packages; a missing or unfinished artifact is an
immediate runtime-unavailable error. A tenant sandbox publishes only one
compatible executable runtime profile at a time.
