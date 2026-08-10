import { execFile as execFileCallback } from 'node:child_process';

/**
 * Error raised when a child process cannot be started or exits unsuccessfully.
 * Keeping the invocation details on the error makes CI failures actionable
 * without requiring callers to reconstruct a command from a formatted string.
 */
export class CommandError extends Error {
  constructor({ executable, args, exitCode = null, signal = null, stdout = '', stderr = '', cause }) {
    const renderedArgs = args.map(argument => JSON.stringify(String(argument))).join(' ');
    const codeText = exitCode === null || exitCode === undefined ? 'unknown' : String(exitCode);
    const detail = stderr.trim();
    super(
      `Command failed: ${executable}${renderedArgs ? ` ${renderedArgs}` : ''} `
        + `(exit code ${codeText})${detail ? `: ${detail}` : ''}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'CommandError';
    this.executable = executable;
    this.args = [...args];
    this.exitCode = typeof exitCode === 'number' ? exitCode : null;
    this.signal = signal ?? null;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = cause && typeof cause.code === 'string' ? cause.code : undefined;
  }
}
/**
 * Execute a program without invoking a shell.
 *
 * Arguments are passed directly to `execFile`, so paths and user-controlled
 * values cannot introduce shell syntax. The returned output is decoded as
 * UTF-8 by default; callers may provide the normal `execFile` options when a
 * different encoding or max buffer is required.
 */
export function runCommand(executable, args = [], options = {}) {
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new TypeError('Command executable must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Command arguments must be an array of strings');
  }

  const {
    cwd,
    env,
    encoding = 'utf8',
    maxBuffer = 64 * 1024 * 1024,
    timeout,
    windowsHide = true,
  } = options;

  return new Promise((resolve, reject) => {
    execFileCallback(
      executable,
      args,
      { cwd, env, encoding, maxBuffer, timeout, windowsHide, shell: false },
      (error, stdout = '', stderr = '') => {
        if (error) {
          reject(new CommandError({
            executable,
            args,
            exitCode: typeof error.code === 'number' ? error.code : null,
            signal: error.signal,
            stdout,
            stderr,
            cause: error,
          }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
