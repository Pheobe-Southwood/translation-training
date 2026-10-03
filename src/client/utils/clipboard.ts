/**
 * Copies text to clipboard reliably across both HTTP and HTTPS,
 * mobile browsers, WeChat webview, and desktop environments.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // Strategy 1: Modern Async Clipboard API (available in Secure Contexts)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to fallback strategy
    }
  }

  // Strategy 2: Legacy execCommand('copy') with invisible textarea (reliable in HTTP)
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;

    // Prevent scrolling and zooming on iOS/mobile
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    textArea.setAttribute('readonly', '');

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, 99999);

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);

    if (successful) {
      return true;
    }
  } catch (err) {
    console.warn('Fallback copy failed:', err);
  }

  // Strategy 3: Ultimate manual fallback prompt
  try {
    window.prompt('请长按或Ctrl+C复制以下内容：', text);
    return true;
  } catch {
    return false;
  }
}
