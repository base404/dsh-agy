/**
 * Credentials import/export tab component.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { h } from './element.ts'
import { button, hint, subhead } from './components.ts'
import type { T } from './types.ts'

export function CredentialsTab(props: {
  busy: boolean
  onImport: (kind: 'json' | 'blob', sources: string[]) => void
  onExportAll: () => void
  t: T
}): ReactNode {
  const { t } = props
  const [text, setText] = useState('')
  const sources = useMemo(
    () => text.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
    [text],
  )
  const suffix = sources.length > 1 ? ` (${sources.length})` : ''
  return h('div', { className: 'agy-root' },
    subhead(t('importTitle')),
    hint(t('importHelp')),
    h('textarea', {
      className: 'agy-textarea',
      style: { marginTop: '8px' },
      value: text,
      placeholder: t('importPlaceholder'),
      onChange: (event: { target: { value: string } }) => { setText(event.target.value) },
    }),
    h('div', { className: 'agy-toolbar', style: { marginTop: '8px' } },
      button(`${t('importJson')}${suffix}`, () => { props.onImport('json', sources) },
        { disabled: props.busy || sources.length === 0 }),
      button(`${t('importBlob')}${suffix}`, () => { props.onImport('blob', sources) },
        { disabled: props.busy || sources.length === 0 }),
      h('span', { className: 'agy-grow' }),
      button(t('exportAll'), () => { props.onExportAll() }, { disabled: props.busy })))
}
