import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { addWhatsAppTemplate, listWhatsAppTemplates, syncWhatsAppTemplates } from '../../api/integrations.js';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import Select from '../../components/ui/Select.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import { errorText } from '../online/OnlineSheets.jsx';

/** A template's approval state, in the words of docs/GLOSSARY.md section 24. */
const STATE_WORDS = Object.freeze({
  DRAFT: { state: 'free', word: 'Draft' },
  PENDING: { state: 'open', word: 'Waiting for Meta' },
  APPROVED: { state: 'ok', word: 'Approved' },
  REJECTED: { state: 'alert', word: 'Rejected' },
  PAUSED: { state: 'alert', word: 'Paused' },
  DISABLED: { state: 'alert', word: 'Switched off' },
});
const CATEGORY_WORDS = Object.freeze({ UTILITY: 'Utility', MARKETING: 'Marketing', AUTHENTICATION: 'Authentication' });

/** The bill receipt as P37 suggests it. The owner adapts the wording before it goes to Meta. */
const RECEIPT_STARTER = Object.freeze({
  key: 'BILL_RECEIPT',
  metaName: 'bill_receipt',
  category: 'UTILITY',
  language: 'en',
  bodyText: 'Thanks for visiting {{1}}! Your bill {{2}} for {{3}} is attached. We hope to see you again.',
  variables: 'restaurantName, billNumber, billTotal',
  example: "Three O'Clock Cafe, 2026-27/000148, ₹795.00",
  submit: 'yes',
});

const list = (text) => text.split(',').map((part) => part.trim()).filter(Boolean);

/**
 * WhatsApp's templates on its sheet. P37. Meta approves templates, not us: each
 * shows its approval state, and a warning when Meta approved it as another
 * category, because costs follow what Meta decided. The owner adds one, either
 * sent to Meta for review or linked to one made in Meta's own screens.
 */
export default function WhatsAppTemplates({ canEdit, onToast }) {
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: ['whatsapp-templates'], queryFn: listWhatsAppTemplates });
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const refresh = (rows) => queryClient.setQueryData(['whatsapp-templates'], rows);

  const sync = useMutation({ mutationFn: syncWhatsAppTemplates, onSuccess: (rows) => { refresh(rows); onToast?.('Read the templates from Meta.'); }, onError: (failure) => setError(errorText(failure)) });
  const add = useMutation({
    mutationFn: () =>
      addWhatsAppTemplate({
        key: form.key,
        metaName: form.metaName,
        category: form.category,
        language: form.language,
        bodyText: form.bodyText,
        variables: list(form.variables),
        example: list(form.example),
        submit: form.submit === 'yes',
      }),
    onSuccess: (rows) => {
      refresh(rows);
      setForm(null);
      setError(null);
      onToast?.('Template saved.');
    },
    onError: (failure) => setError(errorText(failure)),
  });
  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));

  return (
    <div className="grid gap-3 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="type-heading">Templates</h3>
        <Button variant="secondary" size="sm" isLoading={sync.isPending} onClick={() => sync.mutate()}>Read from Meta</Button>
      </div>
      <p className="type-caption text-muted">Meta approves each template before it can be sent. A bill is sent only with an approved Bill receipt.</p>

      {templates.isError && <p className="type-body text-alert">{errorText(templates.error)}</p>}
      {(templates.data ?? []).length === 0 && templates.isSuccess && <p className="type-body text-muted">No templates yet.</p>}
      <ul className="grid gap-2">
        {(templates.data ?? []).map((template) => {
          const chip = STATE_WORDS[template.status] ?? { state: 'free', word: template.status };
          return (
            <li key={template.id} className="grid gap-1 rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="type-label break-words">{template.key}</span>
                <StateChip state={chip.state} word={chip.word} size="sm" />
              </div>
              <p className="type-caption text-muted break-words">
                {template.metaName} · {template.language} · {CATEGORY_WORDS[template.category] ?? template.category}
                {template.approvedCategory && ` · Approved as ${CATEGORY_WORDS[template.approvedCategory] ?? template.approvedCategory}`}
              </p>
              {template.categoryChanged && (
                <p className="type-caption text-alert">Meta approved this as {CATEGORY_WORDS[template.approvedCategory]}, not {CATEGORY_WORDS[template.category]}. It costs what {CATEGORY_WORDS[template.approvedCategory]} costs.</p>
              )}
              {template.rejectionReason && <p className="type-caption text-alert">Meta said: {template.rejectionReason}</p>}
              <p className="type-body break-words">{template.bodyText}</p>
            </li>
          );
        })}
      </ul>

      {canEdit && !form && (
        <Button variant="secondary" size="sm" className="w-fit" onClick={() => setForm({ ...RECEIPT_STARTER })}>Add a template</Button>
      )}
      {canEdit && form && (
        <div className="grid gap-3">
          <Input label="Our name for it" value={form.key} onChange={set('key')} />
          <Input label="Name with Meta" value={form.metaName} onChange={set('metaName')} hint="Lowercase letters, digits and underscores." />
          <Select label="Category" value={form.category} onChange={set('category')} options={[{ value: 'UTILITY', label: 'Utility' }, { value: 'MARKETING', label: 'Marketing' }]} />
          <Input label="Language" value={form.language} onChange={set('language')} />
          <Input label="Text" value={form.bodyText} onChange={set('bodyText')} hint="Variables as {{1}}, {{2}} and so on." />
          <Input label="What fills each variable, in order" value={form.variables} onChange={set('variables')} />
          <Input label="An example for each, for Meta's review" value={form.example} onChange={set('example')} />
          <Select
            label="Send to Meta"
            value={form.submit}
            onChange={set('submit')}
            options={[{ value: 'yes', label: 'Send it to Meta for review' }, { value: 'no', label: 'Already made in Meta: link it' }]}
          />
          {error && <p className="type-body text-alert">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button isLoading={add.isPending} onClick={() => add.mutate()}>Save template</Button>
            <Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {!form && error && <p className="type-body text-alert">{error}</p>}
    </div>
  );
}
