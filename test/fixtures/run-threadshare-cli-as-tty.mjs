#!/usr/bin/env node

Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });

await import("../../bin/threadshare.mjs");
