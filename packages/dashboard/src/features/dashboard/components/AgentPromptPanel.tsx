import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, Maximize2, Sparkles } from 'lucide-react';
import { Button } from '@insforge/ui';

interface AgentPromptPanelProps {
  /** Loads the ready-to-paste prompt (with this project's keys) from the host. */
  requestPrompt: () => Promise<string>;
  /** Opens the host's larger prompt view, if it has one. */
  onOpenFullView?: () => void;
}

/**
 * Shows the host's complete AI integration prompt on the dashboard home, so a
 * new project's first screen is "copy this into your coding agent".
 */
export function AgentPromptPanel({ requestPrompt, onOpenFullView }: AgentPromptPanelProps) {
  const { t } = useTranslation('chrome');
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setError(null);
    requestPrompt()
      .then(setPrompt)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [requestPrompt]);

  useEffect(load, [load]);

  const copy = async () => {
    if (!prompt) {
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(
        t('overview.agentPromptCopyFailed', {
          defaultValue: 'Copy failed. Select the text below and copy it manually.',
        })
      );
    }
  };

  const download = () => {
    if (!prompt) {
      return;
    }
    const url = URL.createObjectURL(new Blob([prompt], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mojobase-integration-prompt.md';
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="relative z-10 flex h-full min-h-0 w-full flex-col gap-4 p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles className="mt-1 h-5 w-5 shrink-0 text-primary" />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-base font-medium leading-7 text-foreground">
              {t('overview.agentPromptPanelTitle', {
                defaultValue: 'Paste this into your AI coding agent',
              })}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t('overview.agentPromptPanelDescription', {
                defaultValue:
                  'Works with Claude Code, Cursor, Codex, Windsurf and Copilot. Run it in your app folder: it has your URL, keys and connection string, plus every step to set up the schema, auth, storage, functions and realtime.',
              })}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            className="h-8 gap-1.5 px-3"
            disabled={!prompt}
            onClick={() => void copy()}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied
              ? t('overview.agentPromptCopied', { defaultValue: 'Copied' })
              : t('overview.agentPromptCopy', { defaultValue: 'Copy prompt' })}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="h-8 gap-1.5 px-3"
            disabled={!prompt}
            onClick={download}
          >
            <Download className="h-4 w-4" />
            .md
          </Button>
          {onOpenFullView && (
            <Button
              type="button"
              variant="secondary"
              className="h-8 w-8 p-0"
              aria-label={t('overview.agentPromptExpand', { defaultValue: 'Open full view' })}
              title={t('overview.agentPromptExpand', { defaultValue: 'Open full view' })}
              onClick={onOpenFullView}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <p className="rounded border border-[var(--alpha-12)] bg-[var(--alpha-4)] px-3 py-2 text-xs leading-5 text-muted-foreground">
        {t('overview.agentPromptSecretNote', {
          defaultValue:
            'Contains your secret API key and database password. Paste it only into tools you trust, and never commit it.',
        })}
      </p>

      {error ? (
        <div className="flex flex-col items-start gap-2 text-sm text-destructive">
          <span>{error}</span>
          <Button type="button" variant="secondary" className="h-8 px-3" onClick={load}>
            {t('overview.agentPromptRetry', { defaultValue: 'Try again' })}
          </Button>
        </div>
      ) : (
        <pre
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--alpha-12)] bg-semantic-1 p-4 font-mono text-xs leading-5 text-foreground"
        >
          {prompt ??
            t('overview.agentPromptLoading', { defaultValue: 'Loading your project prompt…' })}
        </pre>
      )}
    </div>
  );
}
