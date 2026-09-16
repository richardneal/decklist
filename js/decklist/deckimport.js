/* exported DeckImport */
/* global $, fetch */

// Adapted from Richard Neal's MTGGoldfish and MTGTop8 importers.
var DeckImport = {
  // Set this to the deployed Worker URL when the API is hosted separately.
  apiURL: 'https://deck-import.nealston.com/api/import',

  downloadURL: function(value) {
    var url;
    try { url = new URL(value.trim().replace(/^(www\.)?(mtggoldfish\.com|mtgtop8\.com)\//i, 'https://$1$2/')); } catch (_) { return null; }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    var host = url.hostname.replace(/^www\./, '');
    if (host === 'mtggoldfish.com') {
      var match = url.pathname.match(/^\/deck\/(?:download\/)?(\d+)\/?$/);
      return match ? 'https://www.mtggoldfish.com/deck/download/' + match[1] : null;
    }
    if (host === 'mtgtop8.com' && /^\/(event|mtgo)\/?$/.test(url.pathname)) {
      var id = url.searchParams.get('d');
      return /^\d+$/.test(id || '') ? 'https://www.mtgtop8.com/mtgo?d=' + id : null;
    }
    return null;
  },

  split: function(text) {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    // Avoid replacing the user's deck with a proxy error or login page.
    if (!text || /<\/?(?:html|head|body|!doctype)\b/i.test(text)) {
      throw new Error('The site did not return a decklist.');
    }
    var main = [], side = [], inSide = false;
    text.split('\n').forEach(function(line) {
      line = line.trim();
      if (/^sideboard\b/i.test(line) || (!line && main.length)) {
        inSide = true;
      } else if (line) {
        if (/^SB:\s*/i.test(line)) {
          side.push(line.replace(/^SB:\s*/i, ''));
        } else {
          (inSide ? side : main).push(line);
        }
      }
    });
    if (!main.length || !main.concat(side).every(function(line) { return /^\d+x?\s+\S/.test(line); })) {
      throw new Error('The site did not return a valid decklist.');
    }
    return { main: main.join('\n'), side: side.join('\n') };
  },

  importFromParameters: function(params) {
    if (!params || !params.deckimport) return;
    // Embedded deck text takes precedence over a remote deck, even when empty.
    if (Object.prototype.hasOwnProperty.call(params, 'deckmain') ||
        Object.prototype.hasOwnProperty.call(params, 'deckside')) return;
    $('#deckimport').val(params.deckimport);
    return $('#deckimport-button').trigger('click');
  },

  load: async function(value) {
    var url = this.downloadURL(value);
    if (!url) throw new Error('Enter a valid MTGGoldfish or MTGTop8 deck URL.');
    var response = await fetch(this.apiURL + '?source=' + (url.includes('mtggoldfish.com') ? 'mtggoldfish' : 'mtgtop8') + '&id=' + (url.includes('mtggoldfish.com') ? url.split('/').pop() : new URL(url).searchParams.get('d')), { signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      var message = response.headers && response.headers.get('Content-Type')?.includes('text/plain')
        ? (await response.text()).slice(0, 300) : '';
      throw new Error(message || 'The deck download failed (HTTP ' + response.status + ').');
    }
    return this.split(await response.text());
  }
};

$(function() {
  var revision = 0, busy = false, undo = null;
  var button = $('#deckimport-button'), status = $('#deckimport-status');

  function message(text, state) {
    status.text(text).attr('data-state', state || 'info');
  }
  function refresh() {
    var value = $('#deckimport').val().trim();
    var url = DeckImport.downloadURL(value);
    var source = url && (url.includes('mtggoldfish.com') ? 'MTGGoldfish' : 'MTGTop8');
    $('#deckimport-undo').prop('disabled', busy);
    button.prop('disabled', busy || !value).text(busy ? 'Importing…' : 'Import deck');
    $('#deckimport').attr('aria-busy', busy ? 'true' : 'false');
    $('#deckimport-help').text(source ? source + (busy ? ' deck link detected.' : ' deck link detected. Ready to import.') :
      'Open a deck on either site, then copy its address here.');
  }
  function clearUndo() {
    undo = null;
    $('#deckimport-undo').prop('hidden', true);
  }
  $('#deckimport').on('input', function() {
    revision++;
    if (!busy) message('');
    $('#deckimport').attr('aria-invalid', 'false');
    refresh();
  });
  $('#deckmain, #deckside').on('input', function() { revision++; clearUndo(); });
  $('#clearDeck, #loadDeck').on('click', function() { revision++; clearUndo(); message(''); refresh(); });
  button.on('click', async function() {
    if (busy) return;
    var originalMain = $('#deckmain').val(), originalSide = $('#deckside').val();
    var originalURL = $('#deckimport').val(), requestRevision = revision;
    var downloadURL = DeckImport.downloadURL(originalURL);
    if (!downloadURL) {
      $('#deckimport').attr('aria-invalid', 'true');
      message(/mtgtop8\.com/i.test(originalURL) ?
        'Choose a specific deck on MTGTop8, then copy its link. The link needs a d= deck ID.' :
        'Enter a valid MTGGoldfish or MTGTop8 deck URL.', 'error');
      return;
    }
    var source = downloadURL.includes('mtggoldfish.com') ? 'MTGGoldfish' : 'MTGTop8';
    busy = true;
    refresh();
    $('#deckimport').attr('aria-invalid', 'false');
    message('Fetching your deck from ' + source + '…');
    try {
      var deck = await DeckImport.load(originalURL);
      if (revision !== requestRevision || originalURL !== $('#deckimport').val() ||
          originalMain !== $('#deckmain').val() || originalSide !== $('#deckside').val()) {
        message('Import cancelled because the deck or link changed. Your edits are safe; import again when ready.');
        return;
      }
      $('#deckmain').val(deck.main);
      $('#deckside').val(deck.side).trigger('input');
      var count = function(text) {
        return text.split('\n').reduce(function(total, line) { return total + (parseInt(line, 10) || 0); }, 0);
      };
      message('Imported from ' + source + ': ' + count(deck.main) + ' main-deck cards and ' +
        count(deck.side) + ' sideboard cards.', 'success');
      undo = { main: originalMain, side: originalSide, importedMain: deck.main, importedSide: deck.side };
      $('#deckimport-undo').prop('hidden', false);
    } catch (error) {
      var timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      var detail = timedOut ? 'The import timed out.' :
        error instanceof TypeError ? 'Couldn’t reach the import service.' : error.message;
      message(detail + ' Your deck hasn’t changed. Try again, or paste an exported deck below.', 'error');
    } finally {
      busy = false;
      refresh();
    }
  });
  $('#deckimport-undo').on('click', function() {
    if (!undo || busy) return;
    // Also guard against programmatic changes from saved decks or browser history.
    if ($('#deckmain').val() !== undo.importedMain || $('#deckside').val() !== undo.importedSide) {
      clearUndo();
      message('Your deck has changed since importing, so it was left as-is.');
      return;
    }
    var previous = undo;
    $('#deckmain').val(previous.main);
    $('#deckside').val(previous.side).trigger('input');
    clearUndo();
    message('Import undone. Your previous deck has been restored.');
  });
  refresh();
  // main.js has already decoded the initial URL and populated the form.
  DeckImport.importFromParameters($._GET);
  $('#deckimport').on('keydown', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!button.prop('disabled')) button.trigger('click');
    }
  });
});
