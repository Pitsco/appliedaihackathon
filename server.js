// Entry point. The version check runs before anything imports node:sqlite,
// so an old Node prints a clear message instead of a stack trace.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `\nCaseBrief needs Node 22.13 or newer (this is ${process.versions.node}).\n` +
      'Install the current LTS from https://nodejs.org, then run "npm start" again.\n',
  );
  process.exit(1);
}

const { start } = await import('./src/app.js');
start();
