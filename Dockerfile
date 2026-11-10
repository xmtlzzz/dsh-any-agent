# dsh-any-agent as a stdio MCP server in a container.
#
#   docker build -t dsh-any-agent .
#   docker run -i --rm dsh-any-agent
#
# The image holds this server only. It answers the MCP handshake and tools/list
# as is; to actually run a DSH session the container also needs DSH and its
# model credentials, which this project never ships. Either build with
#   --build-arg DSH_VERSION=<version>
# to install @deepseek-ai/dsh into the image, or mount an install and point
# DSH_BIN at its lib/bin.js. Mount your ~/.dsh at /home/node/.dsh for the
# model route and credentials.
#
# Node 24: the server needs >= 22.15, DSH 0.2.2 and later need >= 24.9.
FROM node:24-slim

ARG DSH_VERSION=""
RUN if [ -n "$DSH_VERSION" ]; then npm install -g "@deepseek-ai/dsh@$DSH_VERSION"; fi

WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src

USER node
ENTRYPOINT ["node", "/app/bin/dsh-any-agent.mjs"]
