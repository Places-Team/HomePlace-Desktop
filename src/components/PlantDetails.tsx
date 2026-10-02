import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ChangeEvent } from "react";
import type { Language } from "../lib/i18n";
import { safePlantPhotoPath, validatePlantPhoto, type PlantFeatures, type SyncedPlant } from "../lib/plantSync";

type PhotoReply = { conflict?: boolean; plant?: SyncedPlant };
type PendingPhoto = { name: string; dataUri: string; converted: boolean };

function readAsDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image."));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(blob);
  });
}

async function preparePhoto(file: File, maxBytes: number): Promise<PendingPhoto> {
  if (validatePlantPhoto(file, maxBytes) === null) {
    return { name: file.name, dataUri: await readAsDataUri(file), converted: false };
  }
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") {
    throw new Error("This image format is not supported here. Choose a JPEG, PNG or WebP file.");
  }
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This image could not be converted. Export it as JPEG first."); }
  try {
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable on this device.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const converted = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (!converted || validatePlantPhoto(converted, maxBytes)) throw new Error("The converted photo is still too large.");
    return { name: file.name, dataUri: await readAsDataUri(converted), converted: true };
  } finally { bitmap.close(); }
}

export function PlantDetails({ plant, features, language, onClose, onChanged }: {
  plant: SyncedPlant;
  features: PlantFeatures;
  language: Language;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const ru = language === "ru";
  const [photoPreview, setPhotoPreview] = useState<{ version: string; uri: string } | null>(null);
  const [pending, setPending] = useState<PendingPhoto | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = plant.photo;
  const photoPath = photo && safePlantPhotoPath(photo.url, plant.clientId);

  useEffect(() => {
    let cancelled = false;
    if (!features.plantPhotos || !photoPath || !photo) return;
    const start = window.setTimeout(() => {
      void invoke<string>("link_plant_photo", { clientId: plant.clientId, version: photo.version })
        .then((uri) => { if (!cancelled) { setPhotoPreview({ version: photo.version, uri }); setError(null); } })
        .catch((reason) => { if (!cancelled) setError(String(reason)); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(start); };
  }, [features.plantPhotos, photo, photoPath, plant.clientId]);

  async function selectPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const prepared = await preparePhoto(file, features.maxPlantPhotoBytes);
      setPending(prepared);
      setConflictRevision(null);
      setError(null);
    } catch (reason) { setError(String(reason)); }
  }

  async function uploadPhoto(revision: number) {
    if (!pending) return;
    setBusy(true);
    try {
      const reply = await invoke<PhotoReply>("link_upload_plant_photo", { clientId: plant.clientId, revision, dataUri: pending.dataUri });
      if (reply.conflict) {
        setConflictRevision(reply.plant && !reply.plant.deletedAt ? reply.plant.revision : null);
        setError(ru ? "Растение изменилось на другом устройстве. Выбранное фото сохранено здесь; проверьте новую версию перед заменой." : "This plant changed on another device. Your selected photo is kept here; review the latest version before replacing it.");
      } else {
        setPending(null);
        setConflictRevision(null);
        setPhotoPreview(null);
        setError(null);
      }
      await onChanged();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function deletePhoto() {
    if (!window.confirm(ru ? "Удалить фото растения со всех подключённых устройств?" : "Remove this plant photo from all connected devices?")) return;
    setBusy(true);
    try {
      const reply = await invoke<PhotoReply>("link_delete_plant_photo", { clientId: plant.clientId, revision: plant.revision });
      if (reply.conflict) setError(ru ? "Растение изменилось на другом устройстве. Проверьте актуальное фото и повторите действие." : "This plant changed on another device. Review the current photo and try again.");
      else { setPhotoPreview(null); setError(null); }
      await onChanged();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <div className="plant-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="plant-dialog" role="dialog" aria-modal="true" aria-label={plant.name}>
      <header><div><small>{ru ? "РАСТЕНИЕ" : "PLANT"}</small><h2>{plant.name}</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label={ru ? "Закрыть" : "Close"}>×</button></header>
      {features.plantPhotos ? <div className="plant-dialog-photo">
        {pending ? <img src={pending.dataUri} alt={ru ? `Выбранное фото ${plant.name}` : `Selected photo of ${plant.name}`} /> : photo && photoPreview?.version === photo.version ? <img src={photoPreview.uri} alt={plant.name} /> : <div className="plant-dialog-photo-empty">{photo ? (ru ? "Загружаем фото…" : "Loading photo…") : (ru ? "Пока без фото" : "No photo yet")}</div>}
      </div> : <p>{ru ? "Фото пока не поддерживаются подключённым сервером." : "The connected server does not support plant photos yet."}</p>}
      <div className="plant-dialog-meta"><span>{plant.species || (ru ? "Вид не указан" : "Species not set")}</span><span>{plant.location || (ru ? "Место не указано" : "Location not set")}</span><span>{ru ? `Полив каждые ${plant.intervalDays} дн.` : `Water every ${plant.intervalDays} days`}</span></div>
      {plant.notes && <p className="plant-dialog-notes">{plant.notes}</p>}
      {features.plantPhotos && <div className="plant-dialog-actions">
        <label className="plant-dialog-upload">{ru ? "Выбрать фото" : "Choose photo"}<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={(event) => void selectPhoto(event)} disabled={busy} /></label>
        {pending && <><span className="plant-dialog-pending">{pending.name}{pending.converted ? (ru ? " · JPEG-копия для синхронизации" : " · JPEG copy for sync") : ""}</span><button type="button" disabled={busy || conflictRevision !== null} onClick={() => void uploadPhoto(plant.revision)}>{busy ? (ru ? "Отправляем…" : "Uploading…") : (ru ? "Сохранить фото" : "Save photo")}</button><button type="button" disabled={busy} onClick={() => { setPending(null); setConflictRevision(null); setError(null); }}>{ru ? "Отменить" : "Cancel"}</button></>}
        {conflictRevision !== null && pending && <button type="button" disabled={busy} onClick={() => void uploadPhoto(conflictRevision)}>{ru ? "Заменить актуальное фото" : "Replace current photo"}</button>}
        {photo && !pending && <button type="button" disabled={busy} onClick={() => void deletePhoto()}>{ru ? "Удалить фото" : "Remove photo"}</button>}
      </div>}
      {conflictRevision !== null && photo && photoPreview?.version === photo.version && <div className="plant-dialog-current"><small>{ru ? "Фото на сервере сейчас" : "Current server photo"}</small><img src={photoPreview.uri} alt={ru ? `Актуальное фото ${plant.name}` : `Current photo of ${plant.name}`} /></div>}
      {error && <p className="plant-dialog-error" role="alert">{error}</p>}
      <p className="plant-dialog-privacy">{ru ? "Фото доступно только устройствам этого аккаунта. Оригинал на вашем компьютере не удаляется." : "Only devices on this account can access the photo. The original on your computer is not deleted."}</p>
    </section>
  </div>;
}
