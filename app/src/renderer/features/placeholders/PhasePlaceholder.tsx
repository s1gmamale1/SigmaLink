import { Construction } from 'lucide-react';

interface Props {
  title: string;
  phase: number;
  description: string;
  bullets?: string[];
}

export function PhasePlaceholder({ title, phase, description, bullets }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <Construction className="h-7 w-7 text-muted-foreground" />
      <div className="text-xl font-semibold">{title}</div>
      <div className="rounded-full border border-border px-3 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        Phase {phase}
      </div>
      <div className="max-w-xl text-sm text-muted-foreground">{description}</div>
      {bullets && bullets.length > 0 && (
        <ul className="max-w-xl list-disc space-y-1 pl-6 text-left text-sm text-muted-foreground">
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
