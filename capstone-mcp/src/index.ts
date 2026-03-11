#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
