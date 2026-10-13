import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/** Share a backup as an actual JSON file on Android; download on the web. */
export async function exportJsonBackup(payload: unknown): Promise<void> {
  const json = JSON.stringify(payload, null, 2)
  const filename = `cinevault-backup-${new Date().toISOString().slice(0, 10)}.json`
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({
      path: filename,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    })
    // The Cache directory is temporary: the user must save/share the file.
    await Share.share({
      title: 'Salvar backup do CineVault',
      files: [file.uri],
      dialogTitle: 'Escolha onde salvar o backup',
    })
    return
  }
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1200)
  }
}
