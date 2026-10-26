/**
 * Copies text to the clipboard. The Clipboard API exists only on https and
 * localhost, so a tablet opening the cafe PC at http://192.168.x.x has none
 * (P62). There the text is copied the older way, through a hidden text box,
 * which browsers still allow on plain http when a person tapped a button.
 * Throws when neither works, so the screen can say to copy it by hand.
 */
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.position = 'fixed';
  box.style.top = '0';
  box.style.left = '0';
  box.style.opacity = '0';
  document.body.appendChild(box);
  try {
    box.select();
    box.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('Copy was refused.');
  } finally {
    box.remove();
  }
}
