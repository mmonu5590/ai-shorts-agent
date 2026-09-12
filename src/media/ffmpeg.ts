/**
 * Thin wrappers around the ffmpeg and ffprobe binaries.
 *
 * Both are spawned as argument arrays — never through a shell — so a filename
 * containing spaces, quotes, or shell metacharacters cannot become executable
 * text. Uploaded filenames reach these paths, so that is load-bearing.
 */

import { spawn } from "node:child_process";
import { FfmpegUnavailableError, MediaError } from "./types.ts";

export function ffprobeBinary(): string {
  return process.env["FFPROBE_PATH"] ?? "ffprobe";
}

export function ffmpegBinary(): string {
  return process.env["FFMPEG_PATH"] ?? "ffmpeg";
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs `binary` with `args`, resolving with its output or rejecting with the
 * tail of stderr — ffmpeg reports the actual reason for a failure there, and
 * the last few lines are the part that names it.
 */
export function run(binary: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      // ffmpeg writes continuous progress to stderr; keep only the tail so a
      // long encode cannot grow this unboundedly.
      stderr = (stderr + chunk).slice(-8192);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new FfmpegUnavailableError(binary) : error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().split("\n").slice(-5).join("\n");
      reject(new MediaError(`${binary} exited with code ${code}\n${detail}`));
    });
  });
}

/** True when both binaries can be executed. Used to skip media tests. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await Promise.all([run(ffprobeBinary(), ["-version"]), run(ffmpegBinary(), ["-version"])]);
    return true;
  } catch {
    return false;
  }
}
