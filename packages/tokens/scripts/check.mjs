import { access } from "node:fs/promises";
await access(new URL("../src/tokens.css", import.meta.url));
