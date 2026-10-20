/* exported DeckImport */
/* global $, fetch */

// Adapted from Richard Neal's MTGGoldfish and MTGTop8 importers.
var DeckImport = {
  // Set this to the deployed Worker URL when the API is hosted separately.
  apiURL: 'https://import.decklist.app/api/import',

  // The deck formats the Worker can report, as #deckformat names them.
  formats: ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'commander',
    'premodern', 'oldschool', 'duel', 'paupercommander', 'predh', 'oathbreaker'],

  // MTGTop8 deck links name their format in the f parameter. EDH is Duel Commander.
  mtgtop8Formats: { ST: 'standard', PI: 'pioneer', MO: 'modern', LE: 'legacy', VI: 'vintage', PAU: 'pauper',
    PREM: 'premodern', EDH: 'duel' },

  // Describes a recognized deck link as {source, label, id, url}, or returns null.
  parse: function(value) {
    var url;
    try { url = new URL(value.trim().replace(/^(www\.)?(mtggoldfish\.com|mtgtop8\.com|moxfield\.com|archidekt\.com|scryfall\.com)\//i, 'https://$1$2/')); } catch (_) { return null; }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    var host = url.hostname.replace(/^www\./, '');
    if (host === 'mtggoldfish.com') {
      var match = url.pathname.match(/^\/deck\/(?:download\/)?(\d+)\/?$/);
      return match ? { source: 'mtggoldfish', label: 'MTGGoldfish', id: match[1],
        url: 'https://www.mtggoldfish.com/deck/download/' + match[1] } : null;
    }
    if (host === 'mtgtop8.com' && /^\/(event|mtgo)\/?$/.test(url.pathname)) {
      var id = url.searchParams.get('d'), code = url.searchParams.get('f');
      return /^\d+$/.test(id || '') ? { source: 'mtgtop8', label: 'MTGTop8', id: id,
        url: 'https://www.mtgtop8.com/mtgo?d=' + id,
        format: Object.prototype.hasOwnProperty.call(this.mtgtop8Formats, code) ? this.mtgtop8Formats[code] : '' } : null;
    }
    if (host === 'moxfield.com') {
      // Public deck IDs are 22-character base64url. The floor keeps routes such as
      // /decks/public out, and a trailing segment (a primer, say) is still a deck link.
      var moxfield = url.pathname.match(/^\/decks\/([A-Za-z0-9_-]{16,32})(?:\/[A-Za-z0-9_-]+)?\/?$/);
      return moxfield ? { source: 'moxfield', label: 'Moxfield', id: moxfield[1],
        url: 'https://api2.moxfield.com/v3/decks/all/' + moxfield[1] } : null;
    }
    if (host === 'archidekt.com') {
      // Deck links carry a numeric ID and usually a name slug after it.
      var archidekt = url.pathname.match(/^\/decks\/([1-9]\d{0,11})(?:\/[^/]*)?\/?$/);
      return archidekt ? { source: 'archidekt', label: 'Archidekt', id: archidekt[1],
        url: 'https://archidekt.com/api/decks/' + archidekt[1] + '/' } : null;
    }
    if (host === 'scryfall.com') {
      var scryfall = url.pathname.match(/^\/@[^/]+\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
      var uuid = scryfall && scryfall[1].toLowerCase();
      return scryfall ? { source: 'scryfall', label: 'Scryfall', id: uuid,
        url: 'https://api.scryfall.com/decks/' + uuid + '/export/json' } : null;
    }
    return null;
  },

  downloadURL: function(value) {
    var deck = this.parse(value);
    return deck ? deck.url : null;
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

  // The largest deck file read. A 250-card text list is under 10 KB, and an MTGO .dek
  // under 50 KB.
  maxFileSize: 1024 * 1024,

  // Reads an uploaded deck file into {main, side, name}: an MTGO .dek or Cockatrice .cod
  // (both XML), or a text export. A plain list is split into the two deck boxes like an
  // import; one with headers (Arena's Deck, Commander, About) goes into the main deck box
  // whole, where Decklist.parse() reads its sections, with side set to null.
  fromFile: function(text) {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (/\u0000/.test(text)) throw new Error('That file isn’t a text decklist.');
    if (/^\s*<(?:\?xml|Deck\b|cockatrice_deck\b)/i.test(text)) return this.fromXML(text);
    try {
      var boards = this.split(text);
      boards.name = '';
      return boards;
    } catch (_) {
      text = text.trim();
      if (/<\/?(?:html|head|body|!doctype)\b/i.test(text) || !/^\s*(?:SB:\s*)?\d+x?\s+\S/im.test(text)) {
        throw new Error('That file doesn’t hold a decklist.');
      }
      var about = text.match(/^about\s*\n\s*name\s+(.+)$/im);
      return { main: text, side: null, name: about ? about[1].trim() : '' };
    }
  },

  // An MTGO .dek lists <Cards Quantity="4" Sideboard="false" Name="…"/>, one per
  // printing; a Cockatrice .cod lists <card number="4" name="…"/> in a main or side
  // <zone> (its tokens zone is dropped) and names the deck in <deckname>.
  fromXML: function(xml) {
    var decode = function(value) {
      return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, function(all, dec, hex, named) {
        if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[named.toLowerCase()];
        return String.fromCodePoint(parseInt(dec || hex, dec ? 10 : 16));
      });
    };
    var attributes = function(tag) {
      var found = {}, attribute, re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      while ((attribute = re.exec(tag))) found[attribute[1].toLowerCase()] = decode(attribute[2] !== undefined ? attribute[2] : attribute[3]);
      return found;
    };
    var boards = { main: [], side: [] }, counts = { main: {}, side: {} };
    var add = function(board, quantity, name) {
      quantity = parseInt(quantity, 10);
      name = (name || '').trim();
      if (!board || !name || !(quantity > 0)) return;
      // Merge separate printings of one card.
      if (!Object.prototype.hasOwnProperty.call(counts[board], name)) boards[board].push(name);
      counts[board][name] = (counts[board][name] || 0) + quantity;
    };
    var zone = null, tag, re = /<(\/?)(zone|cards|card)\b([^>]*)>/gi;
    while ((tag = re.exec(xml))) {
      var element = tag[2].toLowerCase(), found = attributes(tag[3]);
      if (element === 'zone') {
        zone = tag[1] ? null : { main: 'main', side: 'side' }[(found.name || '').toLowerCase()] || null;
      } else if (element === 'cards' && !tag[1]) {
        add(found.sideboard === 'true' ? 'side' : 'main', found.quantity, found.name);
      } else if (element === 'card' && !tag[1]) {
        add(zone, found.number, found.name);
      }
    }
    if (!boards.main.length) throw new Error('That file doesn’t hold a decklist.');
    var text = function(board) {
      return boards[board].map(function(name) { return counts[board][name] + ' ' + name; }).join('\n');
    };
    var name = xml.match(/<deckname>([^<]*)<\/deckname>/i);
    return { main: text('main'), side: text('side'), name: name ? decode(name[1]).trim() : '' };
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
    var deck = this.parse(value);
    if (!deck) throw new Error('Enter a valid MTGGoldfish, MTGTop8, Moxfield, Archidekt or Scryfall deck URL.');
    var response = await fetch(this.apiURL + '?source=' + deck.source + '&id=' + encodeURIComponent(deck.id), { signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      var message = response.headers && response.headers.get('Content-Type')?.includes('text/plain')
        ? (await response.text()).slice(0, 300) : '';
      throw new Error(message || 'The deck download failed (HTTP ' + response.status + ').');
    }
    var boards = this.split(await response.text());
    // Moxfield, Archidekt and Scryfall name the deck's format, and an MTGTop8 link
    // can; MTGGoldfish's text export doesn't.
    var format = response.headers && response.headers.get('X-Deck-Format');
    boards.format = this.formats.indexOf(format) !== -1 ? format : (deck.format || '');
    // All but MTGTop8 name the deck, which the Worker sends percent-encoded. An older
    // Worker sends no name at all.
    var name = response.headers && response.headers.get('X-Deck-Name');
    try { boards.name = name ? decodeURIComponent(name).trim() : ''; } catch (_) { boards.name = ''; }
    return boards;
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
    var deck = DeckImport.parse(value);
    var source = deck && deck.label;
    $('#deckimport-undo').prop('disabled', busy);
    button.prop('disabled', busy || !value).text(busy ? 'Importing…' : 'Import deck');
    $('#deckfile-button').prop('disabled', busy);
    $('#deckimport').attr('aria-busy', busy ? 'true' : 'false');
    $('#deckimport-help').text(source ? source + (busy ? ' deck link detected.' : ' deck link detected. Ready to import.') :
      'Open a deck on any of those sites, then copy its address here.');
  }
  function clearUndo() {
    undo = null;
    $('#deckimport-undo').prop('hidden', true);
  }
  function snapshot() {
    return { main: $('#deckmain').val(), side: $('#deckside').val(), format: $('#deckformat').val(),
      name: $('#deckname').val() };
  }
  // Fills the form with an imported or uploaded deck, and keeps an undo of the one it
  // replaces. A deck with no side (a file read whole) clears the sideboard box, and one
  // with no format leaves the form's choice.
  function apply(deck, originals, label) {
    var side = deck.side === null ? '' : deck.side;
    $('#deckmain').val(deck.main);
    // A deck with no format of its own goes back to Auto-detect.
    if (deck.format !== undefined) $('#deckformat').val(deck.format);
    // A deck with no name keeps the one in the form, as does a name typed while the
    // deck was on its way.
    var previousName = $('#deckname').val();
    if (deck.name && previousName === originals.name) $('#deckname').val(deck.name);
    $('#deckside').val(side).trigger('input');
    var count = function(text) {
      return text.split('\n').reduce(function(total, line) {
        return total + (parseInt(line.replace(/^SB:\s*/i, ''), 10) || 0);
      }, 0);
    };
    message(label + ': ' + (deck.side === null ? count(deck.main) + ' cards.' :
      count(deck.main) + ' main-deck cards and ' + count(side) + ' sideboard cards.'), 'success');
    undo = { main: originals.main, side: originals.side, format: originals.format, name: previousName,
      importedMain: deck.main, importedSide: side, importedName: $('#deckname').val() };
    $('#deckimport-undo').prop('hidden', false);
  }
  async function upload(file) {
    if (busy || !file) return;
    var originals = snapshot(), requestRevision = revision;
    try {
      if (file.size > DeckImport.maxFileSize) throw new Error('That file is too big to be a decklist.');
      var deck = DeckImport.fromFile(await file.text());
      if (revision !== requestRevision) return;
      apply(deck, originals, 'Loaded ' + file.name);
    } catch (error) {
      message(error.message + ' Your deck hasn’t changed.', 'error');
    }
  }

  // The Deck link and Text file tabs, with arrow keys moving between them.
  var tabs = $('.import-tabs [role="tab"]');
  function selectTab(tab) {
    tabs.each(function() {
      var selected = this === tab;
      $(this).attr({ 'aria-selected': selected ? 'true' : 'false', tabindex: selected ? null : '-1' });
      $('#' + $(this).attr('aria-controls')).prop('hidden', !selected);
    });
  }
  tabs.on('click', function() { selectTab(this); });
  tabs.on('keydown', function(event) {
    var index = tabs.index(this), next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    var tab = tabs.get((next + tabs.length) % tabs.length);
    selectTab(tab);
    tab.focus();
  });

  $('#deckfile-button').on('click', function() { $('#deckfile').trigger('click'); });
  $('#deckfile').on('change', function() {
    upload(this.files[0]);
    // Let the same file be chosen again after it's edited.
    this.value = '';
  });
  // A file dropped on the drop zone or either deck box is read like an upload. Text
  // dragged in still goes to the deck box as usual.
  var hasFile = function(event) {
    var types = event.originalEvent.dataTransfer && event.originalEvent.dataTransfer.types;
    return types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  };
  $('#deckfile-drop, #deckmain, #deckside').on('dragover', function(event) {
    if (!hasFile(event)) return;
    event.preventDefault();
    event.originalEvent.dataTransfer.dropEffect = 'copy';
    $(this).addClass('dragover');
  }).on('dragleave drop', function() {
    $(this).removeClass('dragover');
  }).on('drop', function(event) {
    if (!hasFile(event)) return;
    event.preventDefault();
    upload(event.originalEvent.dataTransfer.files[0]);
  });

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
    var originals = snapshot(), originalURL = $('#deckimport').val(), requestRevision = revision;
    var target = DeckImport.parse(originalURL);
    if (!target) {
      $('#deckimport').attr('aria-invalid', 'true');
      message(/mtgtop8\.com/i.test(originalURL) ?
        'Choose a specific deck on MTGTop8, then copy its link. The link needs a d= deck ID.' :
        /moxfield\.com/i.test(originalURL) ?
        'Open a single deck on Moxfield, then copy its link. It should look like moxfield.com/decks/\u2026' :
        /archidekt\.com/i.test(originalURL) ?
        'Open a single deck on Archidekt, then copy its link. It should look like archidekt.com/decks/123\u2026' :
        /scryfall\.com/i.test(originalURL) ?
        'Open a single deck on Scryfall, then copy its link. It should look like scryfall.com/@you/decks/\u2026' :
        'Enter a valid MTGGoldfish, MTGTop8, Moxfield, Archidekt or Scryfall deck URL.', 'error');
      return;
    }
    var source = target.label;
    busy = true;
    refresh();
    $('#deckimport').attr('aria-invalid', 'false');
    message('Fetching your deck from ' + source + '…');
    try {
      var deck = await DeckImport.load(originalURL);
      if (revision !== requestRevision || originalURL !== $('#deckimport').val() ||
          originals.main !== $('#deckmain').val() || originals.side !== $('#deckside').val()) {
        message('Import cancelled because the deck or link changed. Your edits are safe; import again when ready.');
        return;
      }
      apply(deck, originals, 'Imported from ' + source);
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
    $('#deckformat').val(previous.format);
    // Leave a name typed since the import.
    if ($('#deckname').val() === previous.importedName) $('#deckname').val(previous.name);
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
