# server image

Read by the core agent when making the server image rules of a core release, and by the lead agent of `build` when deploying the server.

The DEV, STG and PROD servers run as containers of the server image. The procedure for making and deploying it is set by [`build`](../build/SKILL.md).

- `server.tgz` of a core release contains the `Dockerfile`. `ogw build run` makes the server image with `server/core/Dockerfile`, with the game's `server/` as build context
- The base image is pinned by digest. The Node major of the base image equals the Node major that `ogw core test server` ran on: requests to servers that require HTTP/2 (e.g. APNs) go over HTTP/2 because the global `fetch` of that Node picks `h2` through ALPN, and the core tests of `routing` check this. The container process runs as the user with UID 10001 and GID 10001
- The server image contains the server code, the files of `server/build/data/`, the contract generated code, the merged core settings and the game settings values that core reads (for an item whose path has `<ENV>`, only the value of the environment of that build), and contains no secrets
- The label `ogw.compat_client_data_version` of the server image is the value of `server/build/data/compat_client_data_version`. When that file does not exist, it is an empty string
- The entrypoint passes the container arguments as server start arguments and starts the server process entry point `server/core/start.ts` as `## server start` of [SKILL.md](SKILL.md) states. The container arguments are only `--env` (`DEV`, `STG`, `PROD`) and `--matchmaker`
- The server listens with HTTP on port 8080 inside the container
- The host secret store inside the container is the files `/run/secrets/<secret name>`. A secret value is the file content without one trailing newline
