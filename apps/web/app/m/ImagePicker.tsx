'use client';

import { ImagePlus, Loader2, Upload } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { useAssetUrl } from '../../lib/assets';
import { message } from '../../lib/format';
import { TARGETS, uploadImage } from '../../lib/upload';
import { cn } from '../../lib/utils';

/** Pick, shrink and upload an image; shows what is there now. `value` is the stored path, or undefined for none. */
export function ImagePicker(props: {
  kind: keyof typeof TARGETS;
  value: string | undefined;
  onChange: (path: string | undefined) => void;
  label: string;
  help?: ReactNode;
  /** Shown when there is no image (e.g. the shop's initials on its colour). */
  placeholder?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const src = useAssetUrl(props.value);
  const choose = () => input.current?.click();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      props.onChange(await uploadImage(file, TARGETS[props.kind]));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const fileInput = <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/*" className="sr-only" aria-label={props.label} onChange={(e) => void onFile(e.target.files?.[0])} />;
  const spinner = busy && <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white"><Loader2 className="size-7 animate-spin" /></span>;
  const actions = (
    <div className="flex gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={choose}><Upload />{props.value ? 'Replace' : 'Upload'}</Button>
      {props.value && <Button type="button" variant="danger" disabled={busy} onClick={() => props.onChange(undefined)}>Remove</Button>}
    </div>
  );

  if (props.kind === 'logo') {
    return (
      <div className="flex items-center gap-3.5">
        {fileInput}
        <button type="button" onClick={choose} aria-label={`Choose ${props.label.toLowerCase()}`} className="relative size-[72px] shrink-0 cursor-pointer overflow-hidden rounded-[20px]">
          {src ? <img src={src} alt="" className="size-full object-cover" /> : props.placeholder}
          {spinner}
        </button>
        <div className="flex flex-col gap-2">{actions}{props.help && <span className="text-[13px] text-muted">{props.help}</span>}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {fileInput}
      <button
        type="button"
        onClick={choose}
        aria-label={`Choose ${props.label.toLowerCase()}`}
        className={cn(
          'relative w-full cursor-pointer overflow-hidden rounded-2xl',
          props.kind === 'cover' ? 'aspect-[8/3]' : 'aspect-[16/10]',
          !src && !props.placeholder && 'flex flex-col items-center justify-center gap-2 border-2 border-dashed border-field bg-sunken text-muted',
        )}
      >
        {src ? <img src={src} alt="" className="absolute inset-0 size-full object-cover" /> : props.placeholder ?? (
          <>
            <ImagePlus className="size-7" />
            <span className="text-sm font-semibold">Add a photo</span>
          </>
        )}
        {spinner}
      </button>
      {actions}
      {props.help && <span className="text-[13px] text-muted">{props.help}</span>}
    </div>
  );
}
