import { supabase } from '../config/supabase';
import fs from 'fs';
import path from 'path';

/**
 * Upload file to Supabase Storage bucket 'uploads' inside a subfolder for each website/appId ({appId}/{fileName}).
 * If Supabase Storage is configured and bucket 'uploads' exists, returns the public URL from Supabase CDN.
 * Also saves a local copy in uploads/{appId}/{fileName} for static fallback.
 */
export async function uploadMediaFile(
  appId: string,
  filePath: string,
  originalName: string,
  mimeType?: string
): Promise<string> {
  const safeAppId = (appId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = Date.now();
  const safeFileName = `${timestamp}_${originalName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  const storagePath = `${safeAppId}/${safeFileName}`;

  let publicUrl = '';

  // 1. Save local copy under uploads/{safeAppId}/{safeFileName}
  try {
    const localDir = path.join(process.cwd(), 'uploads', safeAppId);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const localFilePath = path.join(localDir, safeFileName);
    fs.copyFileSync(filePath, localFilePath);
    publicUrl = `/uploads/${safeAppId}/${safeFileName}`;
  } catch (err: any) {
    console.error(`[ZaloStorageService] Failed saving local copy:`, err.message);
  }

  // 2. Upload to Supabase Storage bucket 'uploads'
  if (supabase) {
    try {
      const buffer = fs.readFileSync(filePath);

      // Auto ensure bucket exists or upload directly
      const { data, error } = await supabase.storage
        .from('uploads')
        .upload(storagePath, buffer, {
          contentType: mimeType || 'application/octet-stream',
          upsert: true,
        });

      if (!error && data) {
        const { data: publicUrlData } = supabase.storage
          .from('uploads')
          .getPublicUrl(storagePath);

        if (publicUrlData?.publicUrl) {
          console.log(`[Supabase Storage] ✅ Uploaded to Supabase Bucket 'uploads': ${storagePath} -> ${publicUrlData.publicUrl}`);
          return publicUrlData.publicUrl;
        }
      } else if (error) {
        console.warn(`[Supabase Storage] Notice: Could not upload to bucket 'uploads' (${error.message}). Using local server path.`);
      }
    } catch (err: any) {
      console.warn(`[Supabase Storage] Exception uploading to Supabase:`, err.message);
    }
  }

  return publicUrl;
}
