import type { PyodideInterface } from "pyodide";

export const PYODIDE_INDEX_URL =
  "https://cdn.jsdelivr.net/pyodide/v0.29.0/full/";

let pyodidePromise: Promise<PyodideInterface> | null = null;
let hooksInstalled = false;

let pyodideVersion: string | undefined;

let activeStdoutSink: ((chunk: string) => void) | null = null;
let activeStderrSink: ((chunk: string) => void) | null = null;

let activeStdoutDecoder: TextDecoder | null = null;
let activeStderrDecoder: TextDecoder | null = null;

async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const { loadPyodide } = await import("pyodide");
      // The runtime files fetched from indexURL must match the installed
      // `pyodide` npm package version, otherwise startup will throw a
      // version mismatch error.
      const pyodide = await loadPyodide({
        indexURL: PYODIDE_INDEX_URL,
      });
      pyodideVersion = (pyodide as unknown as { version?: string }).version;
      return pyodide;
    })();
  }
  return await pyodidePromise;
}

function ensureStdIoHooks(pyodide: PyodideInterface) {
  if (hooksInstalled) return;
  hooksInstalled = true;

  pyodide.setStdout({
    write: (buffer) => {
      const decoded = activeStdoutDecoder
        ? activeStdoutDecoder.decode(buffer, { stream: true })
        : new TextDecoder().decode(buffer);
      if (decoded.length > 0) activeStdoutSink?.(decoded);
      return buffer.length;
    },
  });

  pyodide.setStderr({
    write: (buffer) => {
      const decoded = activeStderrDecoder
        ? activeStderrDecoder.decode(buffer, { stream: true })
        : new TextDecoder().decode(buffer);
      if (decoded.length > 0) activeStderrSink?.(decoded);
      return buffer.length;
    },
  });
}

export async function ensurePyodideReady(): Promise<void> {
  const pyodide = await getPyodide();
  ensureStdIoHooks(pyodide);
}

export async function getPyodideDebugInfo(): Promise<{
  indexURL: string;
  version?: string;
}> {
  // Ensure it's loaded so we can report the runtime version.
  await ensurePyodideReady();
  return { indexURL: PYODIDE_INDEX_URL, version: pyodideVersion };
}

export async function runPythonAndCaptureStdout(
  code: string
): Promise<{ stdout: string; stderr: string }> {
  const pyodide = await getPyodide();
  ensureStdIoHooks(pyodide);

  let stdout = "";
  let stderr = "";

  activeStdoutDecoder = new TextDecoder();
  activeStderrDecoder = new TextDecoder();

  activeStdoutSink = (chunk) => {
    stdout += chunk;
  };
  activeStderrSink = (chunk) => {
    stderr += chunk;
  };

  try {
    await pyodide.runPythonAsync(code);
  } finally {
    // Flush any pending multibyte sequences.
    if (activeStdoutDecoder) stdout += activeStdoutDecoder.decode();
    if (activeStderrDecoder) stderr += activeStderrDecoder.decode();
    activeStdoutSink = null;
    activeStderrSink = null;
    activeStdoutDecoder = null;
    activeStderrDecoder = null;
  }

  return { stdout, stderr };
}
