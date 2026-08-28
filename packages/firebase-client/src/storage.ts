'use client'

import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  type UploadTaskSnapshot,
} from 'firebase/storage'
import type { FirebaseApp } from 'firebase/app'

export type UploadProgress = {
  bytesTransferred: number
  totalBytes: number
  progress: number
}

export type UploadResult = {
  downloadUrl: string
  path: string
}

/**
 * Firebase Storage インスタンスを取得
 */
export function getFirebaseStorage(app: FirebaseApp) {
  return getStorage(app)
}

/**
 * ファイルをアップロード（進捗コールバック付き）
 */
export async function uploadFile(
  app: FirebaseApp,
  path: string,
  file: Blob | Uint8Array,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult> {
  const storage = getStorage(app)
  const storageRef = ref(storage, path)
  const uploadTask = uploadBytesResumable(storageRef, file)

  return new Promise((resolve, reject) => {
    uploadTask.on(
      'state_changed',
      (snapshot: UploadTaskSnapshot) => {
        if (onProgress) {
          onProgress({
            bytesTransferred: snapshot.bytesTransferred,
            totalBytes: snapshot.totalBytes,
            progress: (snapshot.bytesTransferred / snapshot.totalBytes) * 100,
          })
        }
      },
      (error) => reject(error),
      async () => {
        const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref)
        resolve({ downloadUrl, path })
      }
    )
  })
}

/**
 * ファイルを削除
 */
export async function deleteFile(
  app: FirebaseApp,
  path: string
): Promise<void> {
  const storage = getStorage(app)
  const storageRef = ref(storage, path)
  await deleteObject(storageRef)
}

/**
 * ダウンロード URL を取得
 */
export async function getFileUrl(
  app: FirebaseApp,
  path: string
): Promise<string> {
  const storage = getStorage(app)
  const storageRef = ref(storage, path)
  return getDownloadURL(storageRef)
}
