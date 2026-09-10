import type { ContentGenerationDto } from "@/lib/api";

/**
 * Deliberately platform-neutral: a generic media/hook/caption/CTA stack,
 * not an Instagram frame. Phase 4 can add platform-specific renderers
 * alongside this without changing the generated content model.
 */
export function ContentPreview({ generation }: { generation: ContentGenerationDto }) {
  const image = generation.assets.find((a) => a.type === "image" && a.status === "completed" && a.url);

  return (
    <div className="mx-auto w-full max-w-sm overflow-hidden rounded-xl border border-surface-border bg-surface-raised">
      <p className="border-b border-surface-border px-4 py-2 text-center text-xs uppercase tracking-wide text-white/40">
        Content preview
      </p>

      <div className="flex aspect-square items-center justify-center border-b border-surface-border bg-surface">
        {image?.url ? (
          // Plain <img>, not next/image: generated assets are served from a
          // runtime-configurable media host, so build-time optimization
          // doesn't apply.
          <img src={image.url} alt={generation.altText ?? ""} className="h-full w-full object-cover" />
        ) : (
          <p className="px-6 text-center text-xs text-white/30">
            {generation.format === "text" ? "Text-only post — no media" : "No media generated"}
          </p>
        )}
      </div>

      <div className="space-y-3 p-4">
        {generation.hook ? (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-white/30">Hook</p>
            <p className="text-sm font-medium text-white">{generation.hook}</p>
          </div>
        ) : null}

        {generation.caption ? (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-white/30">Caption</p>
            <p className="whitespace-pre-line text-sm text-white/70">{generation.caption}</p>
          </div>
        ) : null}

        {generation.callToAction ? (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-white/30">CTA</p>
            <p className="text-sm text-sky-400">{generation.callToAction}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
