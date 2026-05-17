@echo off
rem claude-os Windows shim — invokes the compiled CLI with passthrough args.
rem Build the project once via `npm run build` before first use.
node "%~dp0dist\cli\index.js" %*
