if (process.argv[2] === "migrate") {
  process.argv.splice(2, 1);
  await import("./migrate-embedded-command.js");
} else {
  await import("./standalone-cli.js");
}
