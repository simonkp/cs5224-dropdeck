'use client';

import { Download, ExternalLink, Upload } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Sheet } from '../../components/ui/dialog';
import { Segmented } from '../../components/ui/segmented';
import { copyText, shareLink } from '../../lib/share';

export interface ShareTarget {
  title: string;
  subtitle?: string;
  url: string;
  /** The shop page, when the shop has one: offered as a second thing to share. */
  shopUrl?: string;
  shopName?: string;
}

/** Copy, share, or print a QR code for a drop (or the whole shop) to stick on the counter or post on Instagram. */
export function ShareSheet({ target, onClose }: { target: ShareTarget | null; onClose: () => void }) {
  const [which, setWhich] = useState<'drop' | 'shop'>('drop');
  const [qr, setQr] = useState<string | null>(null);
  const url = which === 'shop' && target?.shopUrl ? target.shopUrl : target?.url;
  const label = which === 'shop' ? target?.shopName ?? 'Your shop' : target?.title;

  useEffect(() => {
    setWhich('drop');
  }, [target]);

  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, { width: 640, margin: 2, color: { dark: '#101114', light: '#ffffff' }, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(null));
  }, [url]);

  const saveQr = () => {
    if (!qr) return;
    const a = document.createElement('a');
    a.href = qr;
    a.download = `${(label ?? 'drop').replace(/[^\w-]+/g, '-').toLowerCase()}-qr.png`;
    a.click();
  };

  return (
    <Sheet open={target !== null} onOpenChange={(o) => !o && onClose()} title="Share">
      {target && url && (
        <div className="flex flex-col gap-4">
          {target.shopUrl && (
            <Segmented label="What to share" value={which} onChange={setWhich} options={[{ value: 'drop', label: 'This drop' }, { value: 'shop', label: 'Whole shop' }]} />
          )}
          <div className="flex flex-col items-center gap-2.5 self-center rounded-[20px] border border-line bg-white p-3.5 text-[#101114]">
            {qr ? <img src={qr} alt={`QR code for ${label}`} className="size-[200px]" /> : <div className="size-[200px] animate-pulse rounded-xl bg-[#eef0f3]" />}
            <span className="max-w-[220px] truncate text-[13px] font-bold">{label}{which === 'drop' && target.subtitle ? ` · ${target.subtitle}` : ''}</span>
          </div>
          <div className="flex h-12 items-center gap-2 rounded-[14px] bg-bg pr-1.5 pl-3.5">
            <span className="min-w-0 flex-1 truncate text-sm text-muted">{url.replace(/^https?:\/\//, '')}</span>
            <Button variant="ink" size="sm" onClick={() => void copyText(url, 'Link copied')}>Copy</Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { icon: <Upload />, text: 'Share…', on: () => void shareLink(url, label ?? '') },
              { icon: <Download />, text: 'Save QR', on: saveQr },
              { icon: <ExternalLink />, text: 'Open page', on: () => window.open(url, '_blank', 'noopener') },
            ].map((a) => (
              <button key={a.text} type="button" onClick={a.on} className="flex cursor-pointer flex-col items-center gap-2 text-[13px] font-bold">
                <span className="flex size-14 items-center justify-center rounded-[18px] bg-sunken [&_svg]:size-[22px]">{a.icon}</span>{a.text}
              </button>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}
