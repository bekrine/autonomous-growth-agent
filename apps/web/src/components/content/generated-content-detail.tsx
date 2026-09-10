import type { ContentGenerationDto } from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";
import { ContentPreview } from "./content-preview";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
      <h3 className="mb-3 text-xs uppercase tracking-wide text-white/40">{title}</h3>
      {children}
    </div>
  );
}

/** Renders the format-specific body: reel script, carousel slides, image copy, or text body. */
function GeneratedBody({ generation }: { generation: ContentGenerationDto }) {
  if (generation.script?.length) {
    return (
      <ol className="space-y-3">
        {generation.script.map((scene, i) => (
          <li key={i} className="rounded-lg border border-surface-border p-3">
            <p className="text-xs text-white/40">Scene {i + 1}</p>
            <p className="mt-1 text-sm text-white">{scene.scene}</p>
            <p className="mt-1 text-sm text-white/60">
              <span className="text-white/30">VO:</span> {scene.voiceover}
            </p>
            {scene.onScreenText ? (
              <p className="mt-1 text-sm text-white/60">
                <span className="text-white/30">On-screen:</span> {scene.onScreenText}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    );
  }

  if (generation.slides?.length) {
    return (
      <ol className="space-y-3">
        {generation.slides.map((slide) => (
          <li key={slide.slideNumber} className="rounded-lg border border-surface-border p-3">
            <p className="text-xs text-white/40">Slide {slide.slideNumber}</p>
            <p className="mt-1 text-sm font-medium text-white">{slide.headline}</p>
            <p className="mt-1 text-sm text-white/60">{slide.body}</p>
          </li>
        ))}
      </ol>
    );
  }

  if (generation.body) {
    return <p className="whitespace-pre-line text-sm text-white/70">{generation.body}</p>;
  }

  // Single-image format: on-image headline + supporting line.
  if (generation.headline || generation.supportingText) {
    return (
      <div className="space-y-2">
        {generation.headline ? <p className="text-sm font-medium text-white">{generation.headline}</p> : null}
        {generation.supportingText ? (
          <p className="text-sm text-white/70">{generation.supportingText}</p>
        ) : null}
      </div>
    );
  }

  return <p className="text-sm text-white/30">No body content.</p>;
}

function ReviewPanel({ generation }: { generation: ContentGenerationDto }) {
  const review = generation.review;
  if (!review) return <p className="text-sm text-white/30">Not reviewed yet.</p>;

  const scores = [
    { label: "Overall", value: review.score },
    { label: "Quality", value: review.qualityScore },
    { label: "Brand", value: review.brandScore },
    { label: "Safety", value: review.safetyScore },
  ];

  return (
    <div className="space-y-3">
      <StatusBadge status={review.approved ? "approved" : "rejected"} />
      <div className="grid grid-cols-4 gap-3">
        {scores.map((s) => (
          <div key={s.label}>
            <p className="text-[10px] uppercase tracking-wide text-white/30">{s.label}</p>
            <p className="text-lg font-semibold text-white">{s.value.toFixed(2)}</p>
          </div>
        ))}
      </div>
      {review.issues.length > 0 ? (
        <ul className="space-y-1">
          {review.issues.map((issue, i) => (
            <li key={i} className="text-sm text-rose-400">
              <span className="uppercase text-white/30">{issue.type}:</span> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {review.recommendedChanges.length > 0 ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-white/30">Recommended changes</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {review.recommendedChanges.map((c, i) => (
              <li key={i} className="text-sm text-white/60">
                {c}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function GeneratedContentDetail({
  generation,
  versions,
}: {
  generation: ContentGenerationDto;
  versions: ContentGenerationDto[];
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Section title={`Generated copy · ${generation.format}`}>
          {generation.title ? <p className="mb-3 text-base font-medium text-white">{generation.title}</p> : null}
          <GeneratedBody generation={generation} />
        </Section>

        <Section title="Caption / CTA / Alt text">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-white/30">Caption</dt>
              <dd className="whitespace-pre-line text-white/80">{generation.caption ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-white/30">CTA</dt>
              <dd className="text-white/80">{generation.callToAction ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-white/30">Alt text</dt>
              <dd className="text-white/80">{generation.altText ?? "—"}</dd>
            </div>
            {generation.keywords?.length ? (
              <div>
                <dt className="text-white/30">Keywords</dt>
                <dd className="flex flex-wrap gap-1.5 pt-1">
                  {generation.keywords.map((k) => (
                    <span key={k} className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-white/60">
                      {k}
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
            {generation.contentWarnings?.length ? (
              <div>
                <dt className="text-white/30">Content warnings</dt>
                <dd className="text-amber-400">{generation.contentWarnings.join(", ")}</dd>
              </div>
            ) : null}
          </dl>
        </Section>

        <Section title="Review">
          <ReviewPanel generation={generation} />
        </Section>

        <Section title="Generation history">
          <ol className="space-y-2">
            {versions.map((v) => (
              <li key={v.generationId} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-white/70">
                  v{v.version} · {v.format} · {new Date(v.createdAt).toLocaleString()}
                </span>
                <StatusBadge status={v.review ? (v.review.approved ? "approved" : "rejected") : v.status} />
              </li>
            ))}
            {versions.length === 0 ? <p className="text-sm text-white/30">No versions yet.</p> : null}
          </ol>
        </Section>
      </div>

      <div className="space-y-6">
        <ContentPreview generation={generation} />
        <Section title="Media">
          {generation.assets.length === 0 ? (
            <p className="text-sm text-white/30">No assets.</p>
          ) : (
            <ul className="space-y-2">
              {generation.assets.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-white/60">
                    {a.type} · {a.provider}
                  </span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        {generation.visualDirection ? (
          <Section title="Visual direction">
            <p className="text-sm text-white/70">{generation.visualDirection}</p>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
