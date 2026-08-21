const FFMPEG_CORE_BASE_URL =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'

export async function isMp4Blob(source: Blob) {
  if (source.size < 12) return false
  const header = new Uint8Array(await source.slice(0, 12).arrayBuffer())
  return String.fromCharCode(...header.slice(4, 8)) === 'ftyp'
}

export async function convertWebMToMp4(
  source: Blob,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
) {
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/util'),
  ])

  const ffmpeg = new FFmpeg()
  if (signal?.aborted) throw new DOMException('Export aborted.', 'AbortError')
  const abortHandler = () => ffmpeg.terminate()
  signal?.addEventListener('abort', abortHandler, { once: true })
  const inputName = 'input.webm'
  const outputName = 'output.mp4'
  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)))
  }

  ffmpeg.on('progress', progressHandler)

  try {
    onProgress?.(0)
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    ])
    if (signal?.aborted) throw new DOMException('Export aborted.', 'AbortError')
    await ffmpeg.load({ coreURL, wasmURL }, { signal })
    await ffmpeg.writeFile(inputName, await fetchFile(source), { signal })

    const exitCode = await ffmpeg.exec([
      '-i', inputName,
      '-an',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-r', '30',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputName,
    ], undefined, { signal })

    if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}.`)

    const output = await ffmpeg.readFile(outputName, undefined, { signal })
    if (!(output instanceof Uint8Array) || output.byteLength === 0) {
      throw new Error('FFmpeg did not produce an MP4 file.')
    }

    const bytes = Uint8Array.from(output)
    const mp4Blob = new Blob([bytes.buffer], { type: 'video/mp4' })
    if (!(await isMp4Blob(mp4Blob))) {
      throw new Error('The converted file is not a valid MP4 container.')
    }

    onProgress?.(1)
    return mp4Blob
  } finally {
    signal?.removeEventListener('abort', abortHandler)
    ffmpeg.off('progress', progressHandler)
    if (ffmpeg.loaded) {
      try {
        await ffmpeg.deleteFile(inputName)
      } catch {
        // The input may not exist when loading or conversion fails early.
      }
      try {
        await ffmpeg.deleteFile(outputName)
      } catch {
        // The output may not exist after a failed conversion.
      }
    }
    if (ffmpeg.loaded) ffmpeg.terminate()
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
