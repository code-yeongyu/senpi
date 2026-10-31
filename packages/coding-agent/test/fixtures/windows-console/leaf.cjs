// The process that does the work at the bottom of a launch chain (the Java emulator in firebase-tools' shape):
// it records its own pid, because under shell: true the pid its launcher sees is the cmd.exe in between.
require("node:fs").writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => {}, 30000);
