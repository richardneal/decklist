/* eslint-env browser */
/* global $, jQuery, jsPDF, Decklist */

// global timeout filters
var decklistChangeTimer = null;
var pdfChangeTimer = null;

// Sheet artwork, preloaded into logoCache by id
const LOGOS_CONFIG = [
  // WotC sheet
  { id: 'mtg', file: 'mtg.jpg', format: 'JPEG' },
  // SCG sheet
  { id: 'FUTcreature', file: 'FUTcreature.jpg', format: 'JPEG' },
  { id: 'FUTland', file: 'FUTland.jpg', format: 'JPEG' },
  { id: 'FUTmultiple', file: 'FUTmultiple.jpg', format: 'JPEG' },
  { id: 'FUTsorcery', file: 'FUTsorcery.jpg', format: 'JPEG' },
  { id: 'scglogo', file: 'starcitygames.webp', format: 'JPEG' }
];

// Famous archetypes and their designers, one pair picked at random as the placeholders of
// #deckname and #deckdesigner
const ARCHETYPES = [
  ['The Deck', 'Brian Weissman'],
  ['Sligh', 'Jay Schneider'],
  ['The Rock', 'Sol Malka'],
  ['Turbo Xerox', 'Alan Comer'],
  ['Miracle Grow', 'Alan Comer'],
  ['Napster', 'Mike Flores'],
  ['Jushi Blue', 'Mike Flores'],
  ['Heezy Street', 'Mark Herberholz'],
  ['Red Zone', 'Brian Kibler'],
  ['Next Level Blue', 'Patrick Chapin'],
  ['TurboZvi', 'Zvi Mowshowitz'],
  ['The Solution', 'Zvi Mowshowitz'],
  ['My Fires', 'Zvi Mowshowitz'],
  ['Necro-Donate', 'Dan Burdick'],
  ['Dragonstorm', 'Makihito Mihara'],
  ['Draw-Go', 'Erik Lauer'],
  ['Utility Belt', 'Rob Dougherty'],
  ['Nassiferson', 'Gabriel Nassif'],
  ['Boros Deck Wins', 'Tsuyoshi Fujita'],
  ['Wafo-Tapa Control', 'Guillaume Wafo-Tapa'],
  // Team ChannelFireball's ill-fated Pro Tour Dominaria deck
  ['Simic Karn', 'Team ChannelFireball']
];

// Cache for loaded logo images
var logoCache = {};

// Resolves once every logo has loaded (or failed to)
var logosReady = null;

// Phones and tablets: the preview is drawn by PDF.js, since iOS Safari shows a PDF in an
// iframe at full size, cropped to the frame, and the event date uses the native picker
const touchScreen = window.matchMedia('(pointer: coarse)').matches;

// The one-column layout (decklist.css), where the deck boxes list their own problems
const oneColumn = window.matchMedia('(max-width: 1000px)');

// When the page loads, generate a blank deck list preview
$(document).ready(function() {
  // Initialize dark mode from localStorage
  initDarkMode();

  // A famous archetype and its designer as the deck name and designer placeholders
  const archetype = ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)];
  $('#deckname').attr('placeholder', archetype[0]);
  $('#deckdesigner').attr('placeholder', archetype[1]);

  // Initialize save/load functionality
  initDeckManagement();

  // The brand links home, but a plain click on the generator only scrolls to the
  // top: reloading would clear the form, which isn't saved as it is typed. A
  // modified or middle click still opens a fresh generator
  $('.navbar-brand').on('click', function(event) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Initialize autocomplete for deck textareas
  // Note: initAutocomplete() is now called when cards database loads (see index.html)
  // This ensures the 'cards' object is available before autocomplete initializes

  // Preload the sheet artwork
  logosReady = loadLogos();

  // bind events to all the input fields on the left side, to generate a PDF on change
  $('div.left input:not([type="checkbox"]), div.left textarea, div.left select').on('input', pdfChangeWait);
  $('#eventdate').change(pdfChangeWait);
  // radios and checkboxes are single clicks, not typing, so regenerate right away.
  // The sheet and sort order are in the link too; record it once the current event
  // is done, so a back/forward restore that clicks several radios finishes first
  $('input[type="radio"], input[type="checkbox"]').change(function() {
    generateDecklistPDF();
    setTimeout(pushHistoryState);
  });

  // bind a date picker to the event date (thanks, jQuery UI); a touch screen gets its
  // native one instead, since jQuery UI's opens alongside the keyboard. Both use ISO-8601
  if (touchScreen) {
    document.getElementById('eventdate').type = 'date';
    $('#decklistpreview').empty().addClass('drawn');
  } else {
    $('#eventdate').datepicker({ dateFormat: 'yy-mm-dd' }); // ISO-8601, woohoo
  }

  // also skin the download and permalink buttons
  $('#download').button();
  $('#permalink').button();
  $('input[type=radio]').checkboxradio({
    icon: false
  });

  // initialize field tooltips, replace | with <br /> in tooltip content. In the one-column
  // layout the deck boxes list their problems beneath them, so they open none
  $('.left input, .left textarea').tooltip({
    content: function(callback) {
      if (oneColumn.matches && $(this).is('#deckmain, #deckside')) {
        return callback('');
      }
      callback($(this).prop('title').replace(/\|/g, '<br />'));
    },
    position: {
      my: 'right top+10',
      at: 'right bottom',
      collision: 'flipfit'
    },
    tooltipClass: 'tooltip'
  });

  // parse the GET parameters and set them, also generates preview (via event)
  parseGET();

  // Need to populate an initial history state so the first popstate event
  // has something to return to
  history.replaceState(generatePermalink(true), document.title, generatePermalink());
  // and need to update our state whenever back/forward buttons are pushed.
  window.onpopstate = function(event) {
    parseUrlIntoGET(event.state);
    parseGET();
  }
});

// Blocks updates to the PDF
function pdfChangeWait() {
  // Attempt to parse the decklists and validate input every 400ms
  if (decklistChangeTimer) { clearTimeout(decklistChangeTimer); }
  decklistChangeTimer = setTimeout(function() {
    const parsedInput = Decklist.parse();
    validateInput(parsedInput);
    pushHistoryState();
  }, 400);

  // Wait 1500 milliseconds to generate a new PDF
  if (pdfChangeTimer) { clearTimeout(pdfChangeTimer); }
  pdfChangeTimer = setTimeout(generateDecklistPDF, 1500);
}

// Records the form in the address bar and history, unless the current state already holds it
function pushHistoryState() {
  const newState = generatePermalink(true);
  if (newState !== history.state) {
    console.log("pushing new state " + newState);
    history.pushState(newState, document.title, generatePermalink());
  }
}

// Good ol' Javascript, not having a capitalize function on string objects
String.prototype.capitalize = function() {
  return this.replace( /^([a-z])/g, function(m,p1) { return p1.toUpperCase(); } ); // 1st char
};

// A way to get the GET parameters, setting them in an array called $._GET
function parseUrlIntoDict(url) {
  if (url === '') return {};
  const a = new URL(url).search.substr(1).split('&');
  const b = {};
  for (let i = 0; i < a.length; ++i)
  {
    const p = a[i].split('=');
    if (p.length !== 2) continue;
    b[p[0]] = decodeURIComponent(p[1].replace(/\+/g, ' '));
  }
  return b;
}

function parseUrlIntoGET(url) {
  $._GET = parseUrlIntoDict(url);
}

(function ($) {
  $._GET = parseUrlIntoDict(window.location);
})(jQuery);

// Parse the GET attributes, locking out fields as needed
function parseGET() {
  // disable the fields below if the GET parameter `disablefields` is set to true
  const disableEditing = $._GET['disableediting'] === 'true' ? true : false;
  const params = [
    'firstname',
    'lastname',
    'event',
    'eventdate',
    'eventlocation',
    'deckname',
    'deckdesigner',
    'deckformat',
    'deckimport',
    'deckmain',
    'deckside'
  ];

  // check for event, eventdate, or eventlocation and lock down those input fields
  params.forEach(function(param) {
    const field = '#' + param;

    if ($._GET[ param ] !== undefined) {
      $(field).val( $._GET[param] );    // set it to the GET variable

      if ((param !== 'deckmain') && (param !== 'deckside')) {
        $(field).prop('disabled', disableEditing);  // disable all decklist fields that are in the URL
      }
    }
  });

  // an unknown deckformat selects no option at all; fall back to Auto-detect
  if ($('#deckformat').val() === null) {
    $('#deckformat').val('');
  }

  // Generate the preview once the artwork is in the cache
  logosReady.then(function() {
    generateDecklistPDF();
  });

  // switch to the proper decksheet; doing it this way in case we ever support other formats
  if ($._GET['decksheet'] !== undefined) {
    $('#decksheet-' + $._GET['decksheet']).click();
  }

  // process the decksort param, if present
  if ($._GET['decksort'] !== undefined) {
    $('#sort-' + $._GET['decksort']).click();
  }
}

// The format the deck is checked against: the one chosen, or Auto-detect's guess
function currentDeckFormat(parsedInput) {
  return $('#deckformat').val() || Decklist.detectFormat(parsedInput);
}

// Sorts the sideboard for the sheet. The sideboard of a deck led by its commander (or
// Oathbreaker) keeps the order it was entered in, so an imported deck's commander
// stays on its first line
function sortSideboard(parsedInput) {
  return Decklist.isSingleton(currentDeckFormat(parsedInput)) ? parsedInput['side'] : Decklist.sort(parsedInput['side']);
}

// Calls the appropriate decklist function based on user selection and returns resulting jsPDF object
function generateDecklistLayout(parsedInput) {
  const decksheetFormat = $('#decksheetformatselector input[name=decksheetformat]:checked').prop('id').replace('decksheet-', '');
  if (decksheetFormat === 'wotc') {
    return generateStandardDecklist(parsedInput);
  } else if (decksheetFormat === 'scg') {
    return generateSCGDecklist(parsedInput);
  }
}

// Generates a StarCityGames-formatted decklist
// see: https://static.starcitygames.com/www/pdfs/Decklist.pdf
function generateSCGDecklist(parsedInput) {
  // Create a new SCG dl
  let scgdl = new jsPDF('landscape', 'pt', 'letter');

  // Create color definitions
  const white = [255],
    bggrey = [235],
    black = [43, 46, 52], // used for first page line color, not fully black
    trueblack = [0],      // used for front page text and second page text
    urlblue = [27, 94, 162];

  // Create deck variables
  const maindeck = parsedInput['main'],
    maindeck_count = Decklist.count(maindeck),
    sideboard = sortSideboard(parsedInput),
    sideboard_count = Decklist.count(sideboard),
    letter_page_h = 792; // width is 612pt but not referenced, so no variable

  // Set PDF variables
  scgdl.setFont('helvetica');
  scgdl.setDrawColor.apply(null, black);
  scgdl.setTextColor.apply(null, trueblack);
  scgdl.setLineWidth(1);

  // add first name and last name boxes & text (as well as "required" text)

  const monospaced_fields = {
    'LAST NAME': {
      text: $('#lastname').val().toUpperCase(),
      label_x_offset: 18,
      required: true,
      required_x_offset: pxToPt(118.171),
    },
    'FIRST NAME': {
      text: $('#firstname').val().toUpperCase(),
      label_x_offset: pxToPt(289.152),
      required: true,
      required_x_offset: pxToPt(386.727),
    }
  };
  
  Object.keys(monospaced_fields).forEach(function(key, i) {
    const field = monospaced_fields[key],
      fieldoffset = (i - 1) * 0.8,
      label_font_size = 12,
      label_y = textY(54.6607, label_font_size),
      required_font_size = 4,
      required_y = textY(66.0617, required_font_size),
      field_font_size = 11;

    // draw field label
    scgdl.setFontSize(label_font_size);
    scgdl.setFontStyle('bold');
    scgdl.text(key, field['label_x_offset'], label_y);

    // draw "required" sub-label, if needed
    if (field['required']) {
      scgdl.setFontSize(required_font_size);
      scgdl.setFontStyle('normal');
      scgdl.text('*REQUIRED', field['required_x_offset'], required_y);
    }

    // draw fields and user-entered text
    scgdl.setFontSize(field_font_size);
    scgdl.setFontStyle('normal');
    for (let j = 0; j < 10; j++) {
      const letter_centering_y_offset = 4,
        box_starting_x = 19.5,
        box_w = 18,
        box_h = 21.5,
        box_x_offset = (i * 11 + j) * box_w,
        box_x = box_starting_x + fieldoffset + box_x_offset,
        box_y = 18.5,
        letter = field['text'][j] || '',
        letter_y = field_font_size + box_y + letter_centering_y_offset,
        letter_x = box_x + box_w / 2;

      scgdl.rect(box_x, box_y, box_w, box_h);
      scgdl.text(letter, letter_x, letter_y, null, null, 'center');
    }
  });

  // judge-use box and text

  const judge_x = 616.3,
    judge_y = 18.5,
    judge_w = 81.2,
    judge_h = 44,
    shading_x = 622.8,
    shading_y = 22,
    shading_w = 68.8,
    shading_h = 26,
    divider_font_size = 12,
    divider_x = pxToPt(872.4552),
    divider_y = textY(35.5260375, divider_font_size),
    judge_text_font_size = 9,
    judge_text_x = 656, // hand-kerned as opposed to centered in judge box
    judge_text_y = textY(65.6968, judge_text_font_size);

  // outer box
  scgdl.rect(judge_x, judge_y, judge_w, judge_h);
  // grey inner shading
  scgdl.setFillColor.apply(null, bggrey);
  scgdl.rect(shading_x, shading_y, shading_w, shading_h, 'F');

  // add judge box text (divider and "judge use only" text)
  scgdl.setFontSize(divider_font_size);
  scgdl.setFontStyle('bold');
  scgdl.text('/', divider_x, divider_y);

  scgdl.setFontSize(judge_text_font_size);
  scgdl.setFontStyle('normal');
  scgdl.text('JUDGE USE ONLY', judge_text_x, judge_text_y, null, null, 'center');

  // draw "table number" field and text

  const table_number_font_size = 12,
    table_number_x = pxToPt(958.662),
    table_number_y = textY(54.6607, table_number_font_size),
    player_meeting_font_size = 4,
    player_meeting_x = pxToPt(958.667),
    player_meeting_y = textY(72.4616, player_meeting_font_size);

  for (let i = 0; i < 3; i++) {
    scgdl.rect((719.5 + i * 18), 18.5, 18, 21.5);
  }
  // table number label
  scgdl.setFontSize(table_number_font_size);
  scgdl.setFontStyle('bold');
  scgdl.text('TABLE #', table_number_x, table_number_y);
  // add "at players' meeting" text to table # field
  scgdl.setFontSize(player_meeting_font_size);
  scgdl.setFontStyle('normal');
  scgdl.text('AT PLAYERS\' MEETING', player_meeting_x, player_meeting_y);

  // decklist collection info
  const decklist_collection_font_size = 8.5,
    decklist_collection_x = letter_page_h / 2,
    decklist_collection_y = textY(82.5093, decklist_collection_font_size);

  scgdl.setFontSize(decklist_collection_font_size);
  scgdl.setFontStyle('bolditalic');
  scgdl.text('Judges will come by and collect all decklists at the players’ meeting before the start of the event',
             decklist_collection_x,
             decklist_collection_y,
             null, null, 'center');

  // creature, spells, and lands maindeck sections

  const maindeck_sections = {
      'CREATURES': Decklist.filter(maindeck, 't', '2'),
      'SPELLS': Decklist.filter(maindeck, 't', ['1', '2'], 'exclude'),
      'LANDS': Decklist.filter(maindeck, 't', '1'),
    },
    maindeck_section_title_x_offsets = {
      'CREATURES': pxToPt(121.44),
      'SPELLS': pxToPt(456.48),
      'LANDS': pxToPt(805.44),
    },
    section_title_font_size = 12,
    section_title_y = textY(110.821, section_title_font_size),
    section_offset_y = 103.5,
    section_total_font_size = 11,
    listing_font_size = section_total_font_size,
    section_total_y = 79.5,
    section_total_w = 28,
    section_total_h = 19.2,
    section_total_text_y = section_total_y + section_total_font_size + 3, // hand-kerned
    listing_gap = 257.4,
    listing_w = 240,
    listing_h = 291.5,
    listing_quantity_column_w = 28,
    rows = 15;
  // sort and add separators to deck sections
  Object.keys(maindeck_sections).forEach(function (key) {
    maindeck_sections[key] = Decklist.section(Decklist.sort(maindeck_sections[key]));
  });

  // draw sections and deck entries
  Object.keys(maindeck_sections).forEach(function (key, i) {
    const deck_section = maindeck_sections[key],
      offset_x = 18.7 + i * listing_gap,
      section_total_x = offset_x,
      quantity_column_x = listing_quantity_column_w + offset_x,
      section_total_text_x = section_total_x + section_total_w / 2;

    // section total box
    scgdl.rect(offset_x, section_total_y, section_total_w, section_total_h);
    // section total
    scgdl.setFontSize(section_total_font_size);
    scgdl.setFontStyle('bold');
    scgdl.text(Decklist.count(deck_section).toString(),
               section_total_text_x,
               section_total_text_y,
               null, null, 'center');

    // section title
    scgdl.setFontSize(section_title_font_size);
    scgdl.setFontStyle('bold');
    scgdl.text(key, maindeck_section_title_x_offsets[key], section_title_y);

    // listing area outer border
    scgdl.rect(offset_x, section_offset_y, listing_w, listing_h);
    // column line
    scgdl.line(quantity_column_x, section_offset_y,
               quantity_column_x, section_offset_y + listing_h);
    // row lines and text
    scgdl.setFontSize(listing_font_size);
    scgdl.setFontStyle('normal');
    for (let j = 0; j < rows; j++) {
      const quantity_x = offset_x + listing_quantity_column_w / 2,
        card_name_padding = 5,
        card_x = offset_x + listing_quantity_column_w + card_name_padding,
        card_y = section_offset_y + (j * listing_h / rows) + listing_font_size + 3; // hand-kerned

      // row line
      if (j > 0) { // don't draw a line on top of the outside box
        scgdl.line(offset_x,             section_offset_y + (j * listing_h/rows),
                   offset_x + listing_w, section_offset_y + (j * listing_h/rows));
      }
      // write card
      if (j < deck_section.length) {
        const card = deck_section[j];
        // ignore blank entries
        if (card['q'] > 0) {
          // quantity
          scgdl.text(card['q'].toString(), quantity_x, card_y, null, null, 'center');
          // card name
          scgdl.text(card['n'], card_x, card_y);
        }
      }
    }
  });
  // add section logos from cache
  if (logoCache['FUTcreature']) {
    scgdl.addImage(logoCache['FUTcreature'].data, logoCache['FUTcreature'].format, 59, 73.7, 30, 26.5);
  }
  if (logoCache['FUTsorcery']) {
    scgdl.addImage(logoCache['FUTsorcery'].data, logoCache['FUTsorcery'].format, 317.7, 75, 20, 25.5);
  }
  if (logoCache['FUTland']) {
    scgdl.addImage(logoCache['FUTland'].data, logoCache['FUTland'].format, 565.5, 74.2, 32.3, 25.8);
  }

  // sideboard section

  const sb_x = 18.7,
    sb_y = 413,
    sb_w = 480,
    sb_h = 155.5,
    sb_rows = 8,
    sb_title_font_size = 12,
    sb_font_size = 11,
    sb_quantity_column_w = 28;

  // grey background
  scgdl.setFillColor.apply(null, bggrey);
  scgdl.rect(sb_x, sb_y, sb_w, sb_h, 'F');
  // use a white background for the upper-left corner
  scgdl.setFillColor.apply(null, white);
  scgdl.rect(sb_x, sb_y, sb_w / 2, sb_h / sb_rows, 'F');
  // outer border
  scgdl.rect(sb_x, sb_y, sb_w, sb_h);
  // column lines (divide into two columns and add quantity columns)
  scgdl.line(sb_x + sb_quantity_column_w, sb_y + sb_h/sb_rows,
             sb_x + sb_quantity_column_w, sb_y + sb_h);
  scgdl.line(sb_x + (sb_w/2), sb_y,
             sb_x + (sb_w/2), sb_y + sb_h);
  scgdl.line(sb_x + (sb_w/2) + sb_quantity_column_w, sb_y,
             sb_x + (sb_w/2) + sb_quantity_column_w, sb_y + sb_h);
  // row lines
  for (let i = 1; i < sb_rows; i++) {
    scgdl.line(sb_x,        sb_y + (i * sb_h / sb_rows),
               sb_x + sb_w, sb_y + (i * sb_h / sb_rows));
  }
  // sideboard title
  scgdl.setFontSize(sb_title_font_size);
  scgdl.setFontStyle('bold');
  scgdl.text('SIDEBOARD', pxToPt(67.68), textY(552.421, sb_title_font_size));
  // sideboard logo from cache
  if (logoCache['FUTmultiple']) {
    scgdl.addImage(logoCache['FUTmultiple'].data, logoCache['FUTmultiple'].format, 29.5, 414.8, 15, 15);
  }
  // sideboard cards
  scgdl.setFontSize(sb_font_size);
  scgdl.setFontStyle('normal');
  for (let i = 0; i < sideboard.length && i < 15; i++) {
    const card = sideboard[i],
      row = i + 1, // first row of first column is skipped
      row_y = row % sb_rows * sb_h / sb_rows,
      column_w = sb_w / 2,
      column_no = Math.floor(row / sb_rows),
      offset_x = sb_x + column_no * column_w,
      offset_y = sb_y + row_y;

    //quantity
    scgdl.text(card['q'].toString(),
               offset_x + sb_quantity_column_w / 2,
               offset_y + sb_font_size + 3,
               null, null, 'center');
    // card name
    scgdl.text(card['n'], offset_x + sb_quantity_column_w + 5, offset_y + sb_font_size + 3);
  }

  // main deck and sideboard totals

  const mdsb_totals = {
      'main': {
        title: 'MAIN DECK',
        val: maindeck_count,
        subtitle: '60 CARDS MINIMUM',
      },
      'side': {
        title: 'SIDEBOARD',
        val: sideboard_count,
        subtitle: 'BETWEEN 0 & 15 CARDS',
      },
    },
    mdsb_label_font_size = 11.5,
    mdsb_label_x_offset = pxToPt(767.521),
    mdsb_label_y_offset = textY(572.147, mdsb_label_font_size),
    mdsb_title_y_offset = textY(544.271, mdsb_label_font_size),
    mdsb_subtitle_font_size = 5,
    mdsb_subtitle_y_offset = textY(602.648, mdsb_subtitle_font_size),
    mdsb_font_size = 14;

  // add "total" label
  scgdl.setFontSize(mdsb_label_font_size);
  scgdl.setFontStyle('normal');
  scgdl.text('TOTAL', mdsb_label_x_offset, mdsb_label_y_offset);

  // add totals boxes
  for (let i = 0; i < 2; i++) {
    const mdsb_gap = 77,
      mdsb_x = 620.5 + i * mdsb_gap,
      mdsb_y = 425.5,
      mdsb_w = 63.2,
      mdsb_h = 25.5,
      mdsb_text_x = mdsb_x + mdsb_w / 2,
      mdsb_text_y = mdsb_y + mdsb_font_size + 3, // hand-kerned
      totals_object = Object.values(mdsb_totals)[i],
      totals_title = totals_object['title'],
      totals_subtitle = totals_object['subtitle'],
      totals_text = totals_object['val'].toString();

    // draw outer box
    scgdl.rect(mdsb_x, mdsb_y, mdsb_w, mdsb_h);
    // draw total title
    scgdl.setFontSize(mdsb_label_font_size);
    scgdl.setFontStyle('normal');
    scgdl.text(totals_title, mdsb_x, mdsb_title_y_offset);
    // draw total subtitle
    scgdl.setFontSize(mdsb_subtitle_font_size);
    scgdl.setFontStyle('normal');
    scgdl.text(totals_subtitle, mdsb_x + mdsb_w / 2, mdsb_subtitle_y_offset, null, null, 'center');
    // draw total (if at least one non-zero total)
    if (Object.values(mdsb_totals).some(function(total) { return total.val > 0; })) {
      scgdl.setFontSize(mdsb_font_size);
      scgdl.setFontStyle('normal');
      scgdl.text(totals_text, mdsb_text_x, mdsb_text_y, null, null, 'center');
    }
  }

  // archetype and event boxes and text

  const ae_metadata = {
      'ARCHETYPE': $('#deckname').val().capitalize(),
      'EVENT'    : $('#event').val().capitalize(),
    },
    ae_gap = 40,
    ae_x = 511.5,
    ae_w = 132,
    ae_h = 32,
    ae_title_font_size = 11,
    ae_title_x = 518,
    ae_font_size = 14;
  for (let i = 0; i < 2; i++) {
    const ae_y = 496.5 + i * ae_gap,
      ae_title = Object.keys(ae_metadata)[i],
      ae_text = Object.values(ae_metadata)[i];
    // title is carefully hand-placed; looks better than supposedly mathematically-correct positioning
    if (ae_title === 'ARCHETYPE') {
      var ae_box_cutout_width = 72;
      var ae_title_y = 500;
    } else if (ae_title === 'EVENT') {
      ae_box_cutout_width = 43,
      ae_title_y = 541.5;
    }

    // border
    scgdl.rect(ae_x, ae_y, ae_w, ae_h);
    // cut out space for title
    scgdl.setFillColor.apply(null, white);
    scgdl.rect(ae_x + 3, ae_y - 2, ae_box_cutout_width, 4, 'F');
    // title
    scgdl.setFontSize(ae_title_font_size);
    scgdl.setFontStyle('normal');
    scgdl.text(ae_title, ae_title_x, ae_title_y);
    // text
    scgdl.setFontSize(ae_font_size);
    scgdl.setFontStyle('bold');
    scgdl.text(ae_text, ae_x + 5, ae_y + ae_font_size + (ae_h - ae_font_size) / 2);
  }

  // misc info and disclaimers (bottom of page)

  const disclaimers_font_size = 8.5;
  scgdl.setTextColor.apply(null, black);
  scgdl.setFontSize(disclaimers_font_size);
  scgdl.setFontStyle('bolditalic');
  // y-positioning for the following lines is a bit wonky, so it is calculated by hand rather than via textY()
  scgdl.text('Main Deck must contain at least 60 cards • Sideboard must contain between 0 and 15 cards • If you need additional space for a category, use other columns',
             (letter_page_h / 2),
             pxToPt(762.158) + disclaimers_font_size + 0.5,
             null, null, 'center');
  scgdl.text('Use full English card names • Failure to submit a legal decklist may result in a game loss penalty',
             (letter_page_h / 2),
             pxToPt(775.758) + disclaimers_font_size + 0.5,
             null, null, 'center');

  // SCG logo in bottom-right corner from cache
  if (logoCache['scglogo']) {
    scgdl.addImage(logoCache['scglogo'].data, logoCache['scglogo'].format, 651, 473, 113.5, 88);
  }

  // Add second page
  scgdl.addPage('letter', 'portrait');
  scgdl.setTextColor.apply(null, trueblack);

  // Header
  scgdl.setFontSize(9);
  scgdl.setFontStyle('bold');
  scgdl.text('STAR CITY COMICS & GAMES, INC. PUBLICITY RELEASE & TOURNAMENT POLICIES', 306, 55.117875, null, null, 'center');

  const body_text_x_offset = 70.312875,
    page_two_font_size = pxToPt(11.4667);

  // Consent notice
  scgdl.setFontSize(page_two_font_size);
  scgdl.text('Consent to Photography; Audio and Video Recording and Use Thereof',
             body_text_x_offset,
             80);

  // Body
  scgdl.setFontStyle('normal');
  const paragraphs = [
      {
        text: [
          'Upon the earlier to occur of (i) registering for an StarCityGames.com event or (ii) entering the premises of a ',
          'StarCityGames.com event, you consent to the display, transmittal, distribution, or other use of your name, image, ',
          'voice or likeness and its/their release, publication, exhibition, or reproduction which may be used in whole or ',
          'in part without restriction or limitation in any medium, including by photograph, video, audio taping, or the ',
          'Internet, by StarCityGames.com and/or its affiliates, for any purpose as determined in StarCityGames.com’s sole ',
          'discretion, including, but not limited to, webcasting, for public relations, in news articles or telecasts, in advertising, ',
          'commercial purposes, or by inclusion on StarCityGames.com. You release and hold harmless StarCityGames.com, ',
          'its officers, agents, and employees, and each and all persons involved from any and all claims, demands, causes ',
          'of actions (including any rights of privacy or rights of publicity), liabilities, damages, rights, costs, and expenses ',
          'connected with the display, transmittal, distribution, or other use of your name, image, voice or likeness, including ',
          'the taking, recording, or publication of such interviews, photographs, slides, computer images, video recordings, or ',
          'sound recordings which you have or may in the future have related to the foregoing.'
        ],
        offset: pxToPt(128.061) + page_two_font_size,
      },
      {
        text: [
          'You further agree that upon the earlier to occur of (i) registering for an StarCityGames.com event or (ii) entering the ',
          'premises of an StarCityGames.com Event, you waive all rights you may have to any claims for payment or royalties ',
          'in connection with any exhibition, televising, or other publication, in any medium and whether online or otherwise, ',
          'of the above materials. You also waive any right to inspect or approve any photograph, sound or video recording, ',
          'or film taken by StarCityGames.com, or the person or entity designated by it.'
        ],
        offset: pxToPt(365.394) + page_two_font_size,
      },
    ],
    paragraphLineOffset = pxToPt(18.667);

  // write paragraphs
  paragraphs.forEach(function(paragraph) {
    for (let i = 0; i < paragraph.text.length; i++) {
      scgdl.text(paragraph.text[i],
                 body_text_x_offset,
                 paragraph.offset + i * paragraphLineOffset);
    }
  });

  // Signing lines and text
  // fields listed from left-to-right, top-to-bottom
  const fields = [
      'Name',
      'Signature',
      'Name of Parent or Guardian if minor',
      'Signature of Parent or Guardian, if minor',
      'Date'
    ],
    fieldTextYOrigin = pxToPt(509.394) + page_two_font_size,
    fieldTextYOffset = 42,
    evenFieldXOffset = 286.31025,
    fieldLineYOffset = -10,
    fieldLineLength = 175;

  for (let i = 0; i < fields.length; i++) {
    const lineNumber = Math.floor(i/2),
      evenField = i % 2 === 1,
      yOffset = fieldTextYOrigin + lineNumber * fieldTextYOffset,
      xOffset = (evenField ? evenFieldXOffset : body_text_x_offset),
      lineYOffset = yOffset + fieldLineYOffset;

    // draw line
    scgdl.line(xOffset, lineYOffset, xOffset + fieldLineLength, lineYOffset);
    // draw text
    scgdl.text(fields[i], xOffset, yOffset);
  }

  // SCG tournament policies note
  scgdl.text('A full list of StarCityGames.com Tournament Policies can be obtained from an Event Representative or viewed at',
             body_text_x_offset,
             pxToPt(658.727) + page_two_font_size);
  // set to URL color
  scgdl.setTextColor.apply(null, urlblue);
  scgdl.setDrawColor.apply(null, urlblue);
  const urlXOffset = pxToPt(225.761),
    urlYOffset = pxToPt(677.394) + page_two_font_size;
  scgdl.text('http://static.starcitygames.com/www/pdfs/Tournament_Policy.pdf',
             urlXOffset,
             urlYOffset);
  scgdl.line(urlXOffset,       urlYOffset + 1,
             urlXOffset + 247, urlYOffset + 1);

  return scgdl;

  // helper functions

  // Converts px values to pt values (pt = px * 3/4)
  function pxToPt(px) {
    return px * 3 / 4;
  }
  // Gives an approximate pt value for font Y placement given an offset and font size values
  // Accepts a px value (derived from output PDF) of Y placement, and font size (in pt)
  // Returns an adjusted pt value which should give a close approximate of placement
  function textY(px, font_size) {
    return pxToPt(px) + font_size * 1.1;
  }
}

// Generates a WotC-style decklist
// see: https://wpn.wizards.com/sites/wpn/files/attachements/mtg_constructed_deck_registration_sheet_pdf11.pdf
function generateStandardDecklist(parsedInput) {
  // Create a new dl
  let dl = new jsPDF('portrait', 'pt', 'letter');

  // Create deck variables
  const maindeck = Decklist.section(Decklist.sort(parsedInput['main'])),
    maindeck_count = Decklist.count(maindeck),
    sideboard = sortSideboard(parsedInput),
    sideboard_count = Decklist.count(sideboard);

  // Add the logo from cache
  if (logoCache['mtg']) {
    dl.addImage(logoCache['mtg'].data, logoCache['mtg'].format, 27, 54, 90, 32);
  }

  // Create all the rectangles

  dl.setFillColor(230, 230, 232);

  // Start with the top box, for deck designer, name, etc.
  dl.setLineWidth(1);
  dl.rect(135, 54, 441, 24);  // date + event
  dl.rect(135, 78, 441, 24);  // location + deck name
  dl.rect(355, 54, 221, 72);  // event + deck name + deck designer
  dl.rect(552, 30, 24, 24, 'F');   // first letter
  dl.rect(552, 30, 24, 24);   // first letter
  dl.rect(445, 30, 55, 24);   // table number

  dl.rect(27, 140, 24, 628, 'F');  // last name + first name fills
  dl.rect(27, 140, 24, 449, 'F');  // first name fill

  dl.rect(27, 140, 24, 628);  // last name + first name
  dl.rect(27, 140, 24, 449);  // first name

  dl.rect(250, 748, 56, 22); // total number main deck
  dl.rect(524, 694, 56, 22); // total number side deck
  dl.rect(320, 722, 260, 48); // judge box


  dl.setLineWidth(.5);
  dl.rect(135, 54, 54, 48);   // date + location
  dl.rect(355, 54, 54, 72);   // event + deck name + deck designer
  dl.rect(320, 722, 130, 48); // official use + dc round + status + judge
  dl.rect(320, 722, 260, 12); // official use + main/sb
  dl.rect(320, 734, 260, 12); // dc round + dc round
  dl.rect(320, 746, 260, 12); // status + status

  // Now let's create a bunch of lines for putting cards on
  let y = 186;
  while(y < 750)                  // first column of lines
  {
    dl.line(62, y, 106, y);
    dl.line(116, y, 306, y);
    y += 18;
  }

  y = 186;
  while(y < 386)                  // second column of lines (main deck)
  {
    dl.line(336, y, 380, y);
    dl.line(390, y, 580, y);
    y += 18;
  }

  y = 438;
  while(y < 696)                  // second column of lines (main deck)
  {
    dl.line(336, y, 380, y);
    dl.line(390, y, 580, y);
    y += 18;
  }

  // Get all the various notes down on the page
  // Interleave user input for better copy+paste behavior
  // There are a ton of them, so this will be exciting
  dl.setFontSize(15);
  dl.setFontStyle('normal');
  dl.setFont('helvetica');
  dl.text('DECK REGISTRATION SHEET', 135, 45);

  dl.setFontSize(7);
  dl.setFontStyle('normal');
  dl.text('Table', 421, 40);
  dl.text('Number', 417, 48);
  dl.text('First Letter of', 506, 40);
  dl.text('Last Name', 514, 48);

  const lastname = $('#lastname').val().capitalize();  // the side bar
  if (lastname.length > 0) {
    const lnfl = lastname.charAt(0);
    dl.setFont('helvetica');
    dl.setFontSize(20);
    dl.setFontStyle('bold');
    dl.text(lnfl, 552 + 12, 49, null, null, 'center'); // x offset + half width of outside box
  }

  // put the event name, deck designer, and deck name into the PDF
  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.setFontStyle('normal');
  dl.text('Date:', 169, 68);
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.text($('#eventdate').val(), 192, 69.5);

  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.text('Event:', 386, 68);
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.text($('#event').val().capitalize(), 412, 69.5);

  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.text('Location:', 158, 92);
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.text($('#eventlocation').val().capitalize(), 192, 93.5);

  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.text('Deck Name:', 367, 92);
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.text($('#deckname').val().capitalize(), 412, 93.5);

  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.text('Deck Designer:', 359, 116);
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.text($('#deckdesigner').val().capitalize(), 412, 117.5);

  dl.setFont('helvetica');
  dl.setFontSize(13);
  dl.text('PRINT CLEARLY USING ENGLISH CARD NAMES', 36, 121);

  // put the last name into the PDF
  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.setFontStyle('normal');
  dl.text('Last Name:', 41, 760, 90);
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.setFontStyle('bold');
  dl.text(lastname, 43, 722, 90);

  // put the first name into the PDF
  const firstname = $('#firstname').val().capitalize();
  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.setFontStyle('normal');
  dl.text('First Name:', 41, 581, 90);  // rotate
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.setFontStyle('bold');
  dl.text(firstname, 43, 542, 90);

  const separateBasicLands = document.getElementById('separate-basic-lands').checked;
  const pages = paginateStandardMainDeck(standardMainDeckRows(maindeck, separateBasicLands));

  // Add the deck to the decklist
  dl.setFont('helvetica');
  dl.setFontStyle('normal');
  dl.setFontSize(13);
  dl.text('Main Deck:', 62, 149);
  if (separateBasicLands) dl.text('Main Deck Continued & Basic Lands:', 336, 149);
  else dl.text('Main Deck Continued:', 336, 149);
  drawStandardColumnHeadings(dl);
  drawStandardCardRows(dl, pages[0][0], 82, 182);
  drawStandardCardRows(dl, pages[0][1], 356, 182);

  dl.setFont('helvetica');
  dl.setFontSize(13);
  dl.setFontStyle('normal');
  dl.text('Sideboard:', 336, 404);
  dl.setFontSize(11);
  dl.text('# in deck:', 336, 420); // second row, sideboard
  dl.line(336, 421, 386, 421);
  dl.text('Card Name:', 396, 420);
  dl.line(396, 421, 457, 421);

  // Add the sideboard to the decklist
  dl.setFont('helvetica');
  dl.setFontSize(12);
  dl.setFontStyle('normal');
  for (let i = 0, x = 356, y = 434; i < 15 && i < sideboard.length; i++, y += 18) {
    dl.text(sideboard[i]['q'].toString(), x, y);
    fitText(dl, sideboard[i]['n'], x + 38, y, STANDARD_NAME_WIDTH);
  }

  // Add the maindeck count
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.text('Total Number of Cards in Main Deck:', 62, 768);
  dl.setFont('helvetica');
  dl.setFontSize(20);
  dl.setFontStyle('normal');
  if (maindeck_count !== 0) {
    dl.text(String(maindeck_count), 250 + 56 / 2, 766, null, null, 'center');
  }

  // Add the sideboard count
  dl.setFont('helvetica');
  dl.setFontSize(11);
  dl.text('Total Number of Cards in Sideboard:', 336, 714);
  dl.setFont('helvetica');
  dl.setFontSize(20);
  dl.setFontStyle('normal');
  if (sideboard_count !== 0) {
    dl.text(String(sideboard_count), 524 + 56 / 2, 712, null, null, 'center');
  }

  dl.setFont('helvetica');
  dl.setFontSize(5);
  dl.setFontStyle('normal');
  dl.text('FOR OFFICAL USE ONLY', 324, 730);

  dl.setFontSize(6);
  dl.setFontStyle('normal');
  dl.text('Deck Check Rd #:', 324, 742); // first row
  dl.text('Status:', 324, 754);
  dl.text('Judge:', 324, 766);

  dl.text('Main/SB:', 454, 730);        // second row
  dl.text('/', 520, 730);
  dl.text('Deck Check Rd #:', 454, 742);
  dl.text('Status:', 454, 754);
  dl.text('Judge:', 454, 766);

  drawStandardFooter(dl, 1, pages.length);

  // Main decks that outgrow the first page continue on extra pages
  for (let page = 1; page < pages.length; page++) {
    dl.addPage();
    drawStandardContinuationPage(dl, pages[page], page + 1, pages.length);
  }

  return dl;
}

// Width available to a card name on the WotC sheet, from the name's start to the end of its line
const STANDARD_NAME_WIDTH = 184;

// Rows per column on the WotC sheet: the first page shares its second column with the
// sideboard, while continuation pages give both columns the full height
const STANDARD_FIRST_PAGE_ROWS = [32, 12];
const STANDARD_CONTINUATION_ROWS = [32, 32];

// Accepts the sorted and sectioned main deck
// Returns the rows to print; when basic lands are kept separate they move to the end,
// starting no earlier than the second column under its "& Basic Lands" heading
function standardMainDeckRows(maindeck, separateBasicLands) {
  if (!separateBasicLands) return maindeck;

  const basicLands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest',
    'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Mountain',
    'Snow-Covered Forest', 'Wastes'];
  // Taking the basics out can leave a spacer at the top or two in a row; drop those
  const nonBasicLands = maindeck
      .filter(card => !basicLands.includes(card['n']))
      .filter((card, i, list) => card['q'] !== 0 || (i > 0 && list[i - 1]['q'] !== 0)),
    padding = Math.max(0, STANDARD_FIRST_PAGE_ROWS[0] - nonBasicLands.length);
  return [
    ...nonBasicLands,
    ...Array.from({ length: padding }, () => ({ n: '', q: 0 })),
    ...maindeck.filter(card => basicLands.includes(card['n']))
  ];
}

// Splits main deck rows into pages of two columns each
// Spacer rows (quantity 0) are dropped where they would start a column or end the list
// Always returns at least one page
function paginateStandardMainDeck(rows) {
  let end = rows.length;
  while (end > 0 && rows[end - 1]['q'] === 0) end--;

  const pages = [];
  let index = 0;
  do {
    const capacities = pages.length === 0 ? STANDARD_FIRST_PAGE_ROWS : STANDARD_CONTINUATION_ROWS;
    pages.push(capacities.map(function (capacity) {
      while (index < end && rows[index]['q'] === 0) index++;
      const column = rows.slice(index, Math.min(index + capacity, end));
      index += column.length;
      return column;
    }));
  } while (index < end);

  return pages;
}

// Writes one column of cards, one row every 18pt starting at y; spacer rows stay blank
function drawStandardCardRows(dl, column, x, y) {
  dl.setFont('helvetica');
  dl.setFontSize(12);
  dl.setFontStyle('normal');
  column.forEach(function (card, i) {
    if (card['q'] === 0) return;
    const rowY = y + i * 18,
      xOffset = (card['q'] > 9 && card['q'] < 100) ? 3 : 0;  // Check if 'q' is two digits
    dl.text(card['q'].toString(), x - xOffset, rowY);
    fitText(dl, card['n'].toString(), x + 38, rowY, STANDARD_NAME_WIDTH);
  });
}

// Writes text no wider than maxWidth, shrinking the font down to 7pt and then
// cutting the end off with an ellipsis; the font size is restored afterwards
function fitText(dl, text, x, y, maxWidth) {
  const fontSize = dl.internal.getFontSize();
  let size = fontSize;
  while (size > 7 && dl.getTextWidth(text) > maxWidth) {
    size -= 0.5;
    dl.setFontSize(size);
  }
  if (dl.getTextWidth(text) > maxWidth) {
    while (text.length > 1 && dl.getTextWidth(text + '...') > maxWidth) {
      text = text.slice(0, -1);
    }
    text = text.trimEnd() + '...';
  }
  dl.text(text, x, y);
  dl.setFontSize(fontSize);
}

// The "# in deck" / "Card Name" headings above both card columns
function drawStandardColumnHeadings(dl) {
  dl.setFont('helvetica');
  dl.setFontStyle('normal');
  dl.setFontSize(11);
  dl.text('# in deck:', 62, 166);  // first column
  dl.line(62, 167, 111, 167);
  dl.text('Card Name:', 122, 166);
  dl.line(122, 167, 183, 167);
  dl.text('# in deck:', 336, 166); // second column
  dl.line(336, 167, 386, 167);
  dl.text('Card Name:', 396, 166);
  dl.line(396, 167, 457, 167);
}

// The page number (on multi-page sheets) and the Wizards copyright along the bottom edge
function drawStandardFooter(dl, page, pageCount) {
  dl.setFont('helvetica');
  dl.setFontStyle('normal');
  if (pageCount > 1) {
    dl.setFontSize(8);
    const note = page < pageCount ? ` - main deck continues on page ${page + 1}` : '';
    dl.text(`Page ${page} of ${pageCount}${note}`, 62, 780);
  }
  dl.setFontSize(6);
  const currentYear = new Date().getFullYear();
  dl.text(`TM & © ${currentYear} Wizards of the Coast LLC`, 475, 780); // wizards copyright
}

// The player's name down the left edge, as on the first page
function drawStandardNameSidebar(dl, firstname, lastname) {
  dl.setFillColor(230, 230, 232);
  dl.setLineWidth(1);
  dl.rect(27, 140, 24, 628, 'F');
  dl.rect(27, 140, 24, 628);
  dl.rect(27, 140, 24, 449);

  dl.setFont('helvetica');
  dl.setFontSize(7);
  dl.setFontStyle('normal');
  dl.text('Last Name:', 41, 760, 90);
  dl.text('First Name:', 41, 581, 90);
  dl.setFontSize(11);
  dl.setFontStyle('bold');
  dl.text(lastname, 43, 722, 90);
  dl.text(firstname, 43, 542, 90);
}

// A continuation page: the player and event details again, then two full columns of main deck
function drawStandardContinuationPage(dl, columns, page, pageCount) {
  const firstname = $('#firstname').val().capitalize(),
    lastname = $('#lastname').val().capitalize();

  if (logoCache['mtg']) {
    dl.addImage(logoCache['mtg'].data, logoCache['mtg'].format, 27, 54, 90, 32);
  }

  dl.setFont('helvetica');
  dl.setFontSize(15);
  dl.setFontStyle('normal');
  dl.text('DECK REGISTRATION SHEET (CONTINUED)', 135, 45);

  // first letter of last name, as on the first page
  dl.setFillColor(230, 230, 232);
  dl.setLineWidth(1);
  dl.rect(552, 30, 24, 24, 'F');
  dl.rect(552, 30, 24, 24);
  dl.setFontSize(7);
  dl.text('First Letter of', 506, 40);
  dl.text('Last Name', 514, 48);
  if (lastname.length > 0) {
    dl.setFontSize(20);
    dl.setFontStyle('bold');
    dl.text(lastname.charAt(0), 552 + 12, 49, null, null, 'center');
  }

  // name, event, date and deck name
  dl.setLineWidth(1);
  dl.rect(135, 54, 441, 24);
  dl.rect(135, 78, 441, 24);
  dl.rect(355, 54, 221, 48);
  dl.setLineWidth(.5);
  dl.rect(135, 54, 54, 48);
  dl.rect(355, 54, 54, 48);

  const fullName = [lastname, firstname].filter(Boolean).join(', ');
  [
    ['Name:', 165, 68, fullName, 192, 69.5],
    ['Date:', 169, 92, $('#eventdate').val(), 192, 93.5],
    ['Event:', 386, 68, $('#event').val().capitalize(), 412, 69.5],
    ['Deck Name:', 367, 92, $('#deckname').val().capitalize(), 412, 93.5]
  ].forEach(function ([label, labelX, labelY, value, valueX, valueY]) {
    dl.setFont('helvetica');
    dl.setFontStyle('normal');
    dl.setFontSize(7);
    dl.text(label, labelX, labelY);
    dl.setFontSize(11);
    fitText(dl, value, valueX, valueY, (valueX < 355 ? 355 : 576) - valueX - 4);
  });

  dl.setFontSize(13);
  dl.text('PRINT CLEARLY USING ENGLISH CARD NAMES', 36, 121);

  drawStandardNameSidebar(dl, firstname, lastname);

  // card lines, full height in both columns
  dl.setLineWidth(.5);
  for (let y = 186; y < 750; y += 18) {
    dl.line(62, y, 106, y);
    dl.line(116, y, 306, y);
    dl.line(336, y, 380, y);
    dl.line(390, y, 580, y);
  }

  dl.setFont('helvetica');
  dl.setFontStyle('normal');
  dl.setFontSize(13);
  dl.text('Main Deck Continued:', 62, 149);
  dl.text('Main Deck Continued:', 336, 149);
  drawStandardColumnHeadings(dl);
  drawStandardCardRows(dl, columns[0], 82, 182);
  drawStandardCardRows(dl, columns[1], 356, 182);

  drawStandardFooter(dl, page, pageCount);
}

// The link that pre-fills the form as it stands. The address bar and history use
// this page's own origin, so they work on localhost; a shared link always points
// at the live site. Everything rides in the link itself and nothing is sent anywhere
function generatePermalink(includeBlank = false, origin = window.location.origin) {
  const params = ['firstname', 'lastname', 'event', 'eventdate', 'eventlocation', 'deckmain', 'deckside', 'deckname', 'deckdesigner', 'deckformat'];
  const values = params.map(param => [param, $('#' + param).val()])
    .filter(([, value]) => value !== undefined && (includeBlank || value.length > 0));

  // The sheet and sort order are radios, named as parseGET() clicks them (#decksheet-scg,
  // #sort-color). A link leaves them out at their defaults; the history state keeps
  // them, so going back to a state restores them
  [['decksheet', 'decksheetformat', 'decksheet-', 'wotc'], ['decksort', 'sortorder', 'sort-', 'type']]
    .forEach(([param, name, prefix, fallback]) => {
      const value = $('input[name=' + name + ']:checked').prop('id').replace(prefix, '');
      if (includeBlank || value !== fallback) values.push([param, value]);
    });

  // + for spaces keeps a long deck's link shorter; parseUrlIntoDict reads both
  const query = values.map(([param, value]) => param + '=' + encodeURIComponent(value).replace(/%20/g, '+')).join('&');
  return origin + '/' + (query ? '?' + query : '');
}

// Shares the permalink: the native share sheet on a phone or tablet, the clipboard
// everywhere else (or if the share sheet fails)
async function sharePermalink() {
  const button = document.getElementById('permalink');
  const label = button.value;
  const permalink = generatePermalink(false, 'https://decklist.app');
  button.disabled = true;

  if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: document.title, url: permalink });
      button.disabled = false;
      return;
    } catch (error) {
      // AbortError: the player closed the share sheet
      if (error.name === 'AbortError') {
        button.disabled = false;
        return;
      }
      console.error('Error while sharing:', error);
    }
  }

  try {
    await navigator.clipboard.writeText(permalink);
    button.value = 'Copied!';
  } catch (error) {
    console.error('Error while copying:', error);
    button.value = 'Failed to Copy';
  }
  setTimeout(() => {
    button.value = label;
    button.disabled = false;
  }, 3000); // Reset button text and state after 3 seconds
}

// Performs validation on user input and updates PDF
function generateDecklistPDF(outputtype = 'dataurlstring') {
  // clear the input timeout before we can generate the PDF
  pdfChangeTimer = null;

  // Parse the deck list
  const parsedInput = Decklist.parse();

  // Validate the input
  validateInput(parsedInput);

  // get complete PDF
  const dl = generateDecklistLayout(parsedInput);

  // Output the dl as a blob to add to the DOM
  if (outputtype === 'dataurlstring' && touchScreen) {
    drawPreview(dl.output('arraybuffer'));
  }
  else if (outputtype === 'dataurlstring') {
    const domdl = dl.output('dataurlstring');

    // If we set the 'src' attr while the iframe is still part of the DOM, we generate
    // a spurious history event.
    var iframe = $('iframe');
    var container = iframe.parent();
    iframe.remove();
    // Put the DOM into the live preview iframe
    iframe.attr('src', domdl);
    container.append(iframe);
  }
  else {
    dl.save('decklist.pdf');
  }
}

// ==================== TOUCH SCREEN PREVIEW ====================

// PDF.js and the worker it parses in, loaded for the first touch screen preview
var pdfjsReady = null;

// Numbers each preview, so one that finishes late can't replace a newer one
var previewNumber = 0;

function loadPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = import(new URL('js/pdfjs/pdf-5.7.284.min.js', document.baseURI).href).then(function(pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('js/pdfjs/pdf.worker-5.7.284.min.js', document.baseURI).href;
      return { pdfjs: pdfjs, worker: new pdfjs.PDFWorker() };
    });
    // a failed load is tried again by the next preview
    pdfjsReady.catch(function() { pdfjsReady = null; });
  }
  return pdfjsReady;
}

// Draws each page of the sheet to a canvas as wide as the preview
async function drawPreview(data) {
  const number = ++previewNumber;
  const container = document.getElementById('decklistpreview');
  try {
    const { pdfjs, worker } = await loadPdfjs();
    const pdf = await pdfjs.getDocument({ data: data, worker: worker, isEvalSupported: false }).promise;
    const canvases = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const scale = container.clientWidth * window.devicePixelRatio / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale: scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Decklist preview, page ' + pageNumber + ' of ' + pdf.numPages);
      await page.render({ canvas: canvas, viewport: viewport }).promise;
      canvases.push(canvas);
    }
    await pdf.destroy();
    if (number === previewNumber) {
      container.replaceChildren(...canvases);
    }
  } catch (error) {
    console.error('Preview failed', error);
    if (number === previewNumber) {
      const message = document.createElement('p');
      message.className = 'preview-unavailable';
      message.textContent = 'The preview couldn’t be drawn. Download the PDF to see your sheet.';
      container.replaceChildren(message);
    }
  }
}

// performs a number of checks against the values filled out in the fields
// and stores any warnings or errors found during these checks within a
// validation object which is used to generate tooltip and status box text
function validateInput(parsedLists) {
  // validation object
  // key = HTML form object (input or textarea) ID
  // value = array of error objects: {error_level: error_type}
  // error levels include 'warning' and 'error'
  // error types include 'blank', 'nonnum', 'toolarge', 'toosmall',
  //       'size', 'unrecognized', 'quantity', 'futuredate', 'continued',
  //       and the format checks from Decklist.check()
  // error objects may have other keys (eg. data) which contain extra information
  const validate = {
    'firstname': [],
    'lastname': [],
    'event': [],
    'eventdate': [],
    'eventlocation': [],
    'deckmain': [],
    'deckside': []
  };
  const maindeck = parsedLists['main'],
    maindeck_count = Decklist.count(maindeck),
    sideboard = parsedLists['side'],
    sideboard_count = Decklist.count(sideboard),
    unrecognized = parsedLists['unrecognized'],
    unparseable = parsedLists['unparseable'];

  // check first name (non-blank, too long)
  const decksheetFormat = $('#decksheetformatselector input[name=decksheetformat]:checked').prop('id').replace('decksheet-', '');
  if (decksheetFormat === 'wotc') {
    var maxFirstNameLength = 20;
    var maxLastNameLength = maxFirstNameLength;
  } else if (decksheetFormat === 'scg') {
    maxFirstNameLength = 10;
    maxLastNameLength = maxFirstNameLength;
  }
  if ($('#firstname').val() === '')                           { validate.firstname.push({ warning: 'blank' });  }
  else if ($('#firstname').val().length > maxFirstNameLength) { validate.firstname.push({ error: 'toolarge' }); }

  // check last name (non-blank, too long)
  if ($('#lastname').val() === '')                          { validate.lastname.push({ warning: 'blank' });  }
  else if ($('#lastname').val().length > maxLastNameLength) { validate.lastname.push({ error: 'toolarge' }); }

  // check event name (non-blank)
  if ($('#event').val() === '') { validate.event.push({ warning: 'blank' }); }

  // check event date (non-blank, unrecognized format, before today)
  if (decksheetFormat !== 'scg') {
    if ($('#eventdate').val() === '')                             { validate.eventdate.push({ warning: 'blank' });      }
    else if (!$('#eventdate').val().match(/^\d{4}-\d{2}-\d{2}$/)) { validate.eventdate.push({ error: 'unrecognized' }); }
    else if (Date.parse($('#eventdate').val()) <= new Date(new Date().setDate(new Date().getDate()-1)).setHours(0)) {
      validate.eventdate.push({ warning: 'futuredate' });
    }
  }

  // check event location (non-blank)
  if (decksheetFormat !== 'scg') {
    if ($('#eventlocation').val() === '') { validate.eventlocation.push({ warning: 'blank' }); }
  }

  // check the deck against its format (size, copies, legality); Auto-detect guesses
  // the format from the deck's shape, and says which it chose
  const chosenFormat = $('#deckformat').val(),
    deckFormat = currentDeckFormat(parsedLists),
    formatCheck = Decklist.check(parsedLists, deckFormat);
  $('#deckformat option[value=""]').text(chosenFormat || maindeck_count + sideboard_count === 0 ? 'Auto-detect' :
    'Auto-detect (' + Decklist.formats[deckFormat].name + ')');
  validate.deckmain.push(...formatCheck.deckmain);
  validate.deckside.push(...formatCheck.deckside);

  // check maindeck (fits the sheet)
  if (decksheetFormat === 'wotc') {
    const separateBasicLands = $('#separate-basic-lands').is(':checked'),
      rows = standardMainDeckRows(Decklist.section(Decklist.sort(maindeck.slice())), separateBasicLands),
      extraPages = paginateStandardMainDeck(rows).length - 1;
    if (extraPages > 0)                                { validate.deckmain.push({ warning: 'continued', data: extraPages }); }
  } else if (decksheetFormat === 'scg') {
    const maindeck_sections = [Decklist.filter(maindeck, 't', '2'), Decklist.filter(maindeck, 't', ['1', '2'], 'exclude'), Decklist.filter(maindeck, 't', '1')].map(Decklist.sort).map(Decklist.section);
    if (maindeck_sections.some(function(arr) { return arr.length > 15; })) {
      validate.deckmain.push({ error: 'sectiontoolarge' });
    }
  }

  // check for unrecognized and unparseable cards
  if (unrecognized.length !== 0) {
    validate.deckmain.push({ warning: 'unrecognized', data: unrecognized });
  }
  if (unparseable.length !== 0) {
    validate.deckmain.push({ warning: 'unparseable', data: unparseable });
  }

  // pass validation data to output status/tooltip information
  statusAndTooltips(validate);
}


// shown in the status box until the user enters something; matches the markup in index.html
const STATUS_PROMPT_HTML = '<li class="prompt">Fill in the form to check your decklist.</li>';

// Change tooltips and status box to reflect current errors/warnings (or lack thereof)
function statusAndTooltips(valid) {
  // notifications are stored as the following:
  // notifications: {
  //   for: [[message, level], [message, level], ...],
  //   for: [[message, level], [message, level], ...],
  //   ...
  // }
  // in this case, the key 'for' represents the input element id, and
  // the value 'level' represents the string 'warning' or 'error'
  const notifications = {};

  // define push method for notifications
  // accepts a key and an array (assumed [message, level] input)
  // if the key does not exist, add [array], else push it to that key's array
  notifications.push = function(key, array) {
    if (typeof this[key] === 'undefined') {
      this[key] = [array];
    } else {
      this[key].push(array);
    }
  };

  // 0x000 is valid, 0x001 is empty, 0x010 is warning, 0x100 is error
  // default error level to 'valid'
  let errorLevel = 0;

  // check for validation objects in every category (firstname, lastname, etc.)
  for (const prop in valid) {
    // check each instance of a warning/error per field
    let proplength = valid[prop].length;
    for (let i = 0; i < proplength; i++) {
      const validationObject = valid[prop][i],
        // store validation object type for abstraction
        validType = (validationObject['warning'] ? 'warning' : 'error');

      // bitwise AND the current error level and that of the validation object
      errorLevel = errorLevel | (validType === 'warning' ? 0x010 : 0x100);

      // add notification message for the validation object
      //   note: this section runs only once per validation object, so all checks
      //   can be run in else-if blocks; only one update is made per object

      if (prop === 'firstname') {
        if (validationObject['warning'] === 'blank') {
          notifications.push(prop, ['Missing first name', validType]);
        } else if (validationObject['error'] === 'toolarge') {
          notifications.push(prop, ['First name too long', validType]);
        }
      } else if (prop === 'lastname') {
        if (validationObject['warning'] === 'blank') {
          notifications.push(prop, ['Missing last name', validType]);
        } else if (validationObject['error'] === 'toolarge') {
          notifications.push(prop, ['Last name too long', validType]);
        }
      } else if (prop === 'event') {
        if (validationObject['warning'] === 'blank') {
          notifications.push(prop, ['Missing event name', validType]);
        }
      } else if (prop === 'eventdate') {
        if (validationObject['warning'] === 'blank') {
          notifications.push(prop, ['Missing event date', validType]);
        } else if (validationObject['warning'] === 'futuredate') {
          notifications.push(prop, ['Event date is set in the past', validType]);
        } else if (validationObject['error'] === 'unrecognized') {
          notifications.push(prop, ['Event dates should be in the following format: YYYY-MM-DD', validType]);
        }
      } else if (prop === 'eventlocation') {
        if (validationObject['warning'] === 'blank') {
          notifications.push(prop, ['Missing event location', validType]);
        }
      } else if (prop === 'deckmain') {
        if (validationObject['warning'] === 'size') {
          notifications.push(prop, ['Most decks consist of exactly 60 cards', validType]); }
        else if (validationObject['error'] === 'toosmall') {
          notifications.push(prop, ['Decks may not consist of less than ' + validationObject['data'] + ' cards', validType]);
        } else if (validationObject['error'] === 'commandertoosmall' || validationObject['error'] === 'commandertoolarge') {
          notifications.push(prop, [validationObject['data']['format'] + ' decks consist of exactly 100 cards, counting the commander (this one has ' +
            validationObject['data']['count'] + ')', validType]);
        } else if (validationObject['error'] === 'oathbreakersize') {
          notifications.push(prop, ['Oathbreaker decks consist of exactly 60 cards, counting the Oathbreaker and its signature spell (this one has ' +
            validationObject['data'] + ')', validType]);
        } else if (validationObject['warning'] === 'continued') {
          const extraPages = validationObject['data'];
          notifications.push(prop, ['The first page has room for 44 rows (including spaces), so the main deck continues on ' +
            (extraPages === 1 ? 'a second page' : extraPages + ' more pages'), validType]);
        } else if (validationObject['error'] === 'sectiontoolarge') {
          notifications.push(prop, ['This PDF only has space for up to 15 cards per section (including spaces)', validType]);
        } else if (validationObject['error'] === 'quantity') {
          // include a list of cards over their limit across the main/side, each with its count and limit
          const excessCardsHtml = '<ul><li>' + validationObject['data']['cards'].join('</li><li>') + '</li></ul>';
          notifications.push(prop, ['The following cards are over their copy limit:' + excessCardsHtml, validType]);
        } else if (validationObject['error'] === 'restricted') {
          const restrictedCardsHtml = '<ul><li>' + validationObject['data']['cards'].join('</li><li>') + '</li></ul>';
          notifications.push(prop, ['The following cards are restricted in ' + validationObject['data']['format'] +
            ', so a deck may hold only one copy:' + restrictedCardsHtml, validType]);
        } else if (validationObject['error'] === 'illegal') {
          const illegalCardsHtml = '<ul><li>' + validationObject['data']['cards'].join('</li><li>') + '</li></ul>';
          notifications.push(prop, ['The following cards are not legal in ' + validationObject['data']['format'] + ':' +
            illegalCardsHtml, validType]);
        } else if (validationObject['warning'] === 'unrecognized') {
          // include a list of unrecognized card names
          const unrecognizedCardsHtml = '<ul><li>' + validationObject['data'].join('</li><li>') + '</li></ul>';
          notifications.push(prop, ['Couldn\'t recognize the following card(s):' + unrecognizedCardsHtml, validType]);
        } else if (validationObject['warning'] === 'unparseable') {
          // include a list of unparseable lines
          const unparseableCardsHtml = '<ul><li>' + validationObject['data'].join('</li><li>') + '</li></ul>';
          notifications.push(prop, ['Couldn\'t parse the following lines:' + unparseableCardsHtml, validType]);
        }
      } else if (prop === 'deckside') {
        if (validationObject['warning'] === 'toosmall') {
          notifications.push(prop, ['Most sideboards consist of exactly 15 cards', validType]);
        } else if (validationObject['error'] === 'toolarge') {
          notifications.push(prop, ['Sideboards may not consist of more than 15 cards', validType]);
        } else if (validationObject['warning'] === 'nocommander') {
          notifications.push(prop, ['List your commander in the sideboard', validType]);
        } else if (validationObject['warning'] === 'commanderside') {
          notifications.push(prop, ['A Commander deck\'s sideboard holds only its commander and any companion', validType]);
        } else if (validationObject['error'] === 'notcommander') {
          const notCommanderHtml = '<ul><li>' + validationObject['data']['cards'].join('</li><li>') + '</li></ul>';
          notifications.push(prop, ['The following cards may not be your commander in ' + validationObject['data']['format'] + ':' +
            notCommanderHtml, validType]);
        } else if (validationObject['warning'] === 'nooathbreaker') {
          notifications.push(prop, ['List your Oathbreaker and its signature spell in the sideboard', validType]);
        } else if (validationObject['warning'] === 'oathbreakerside') {
          notifications.push(prop, ['An Oathbreaker deck\'s sideboard holds only its Oathbreaker and signature spell', validType]);
        }
      }
    }
  }

  // check if all fields are empty; if they are, set errorLevel accordingly
  // close active tooltips, clear titles and classes for new tooltip text
  // only text fields count: radios and checkboxes always report a value ('on')
  let allEmpty = true;
  $('.left input, .left textarea').tooltip('close');
  $('.left input, .left textarea').each(function() {
    if ($(this).is('input[type="text"], input[type="url"], input[type="date"], textarea') && $(this).val()) {
      allEmpty = false;
    }
    $(this).prop('title', '');
    $(this).removeClass('warning error');
  });
  if (allEmpty) {
    errorLevel = 0x001;
  }

  // compose new notifications HTML fragment, set new tooltips, and set input field classes
  let statusBoxHtml = '';
  for (const key in notifications) {
    // exclude any functions of the object, and stay quiet until something is entered
    if (!allEmpty && typeof notifications[key] !== 'function') {
      let newTitle = '';

      const notificationsLength = notifications[key].length;
      let fieldClass = 'warning';
      for (let i = 0; i < notificationsLength; i++) {
        // create status box HTML fragment
        statusBoxHtml += '<li class=\'' + notifications[key][i][1] + '\'>';
        statusBoxHtml += '<label for=\'' + key + '\'>';
        statusBoxHtml += notifications[key][i][0] + '</label></li>';

        // determine field class
        if (notifications[key][i][1] === 'error') {
          fieldClass = 'error';
        }

        // construct field notification string
        if (notificationsLength === 1) {
          // don't add a bullet, there's only one line for this field
          newTitle = notifications[key][0][0];
        } else {
          // don't add a newline denotator (vertical bar) for first entry
          if (i !== 0) {
            newTitle += '|';
          }
          newTitle += '&bull; ' + notifications[key][i][0];
        }
      }

      // update field class and title
      const fieldId = '#' + key;
      $(fieldId).addClass(fieldClass);

      // add a tooltip only for errors; people were complaining about overzealous tooltips
      if (fieldClass === 'error') { $(fieldId).prop('title', newTitle); }
    }
  }

  if (allEmpty) {
    statusBoxHtml = STATUS_PROMPT_HTML;
  }

  // list each deck box's problems beneath it too; the one-column layout shows them there,
  // a long scroll away from the status box
  ['deckmain', 'deckside'].forEach(function(key) {
    const fieldNotifications = allEmpty ? [] : (notifications[key] || []);
    $('#' + key + '-messages').html(fieldNotifications.map(function(notification) {
      return '<li class=\'' + notification[1] + '\'>' + notification[0] + '</li>';
    }).join(''));
  });

  // compute new status
  let newStatus = 'valid';
  if (errorLevel & 0x100)      { newStatus = 'error'; }
  else if (errorLevel & 0x010) { newStatus = 'warning'; }
  else if (errorLevel & 0x001) { newStatus = 'empty'; }

  // set new status, display new notifications
  $('.status').removeClass('default empty valid warning error').addClass(newStatus);
  $('.status .details').html(statusBoxHtml);
}

document.addEventListener('DOMContentLoaded', (event) => {
  const currentYear = new Date().getFullYear();
  document.getElementById('current-year').textContent = currentYear;
});

// ==================== LOGO LOADING ====================

// Load every logo in LOGOS_CONFIG into the cache as a data URL
function loadLogos() {
  return Promise.all(LOGOS_CONFIG.map(function(logoConfig) {
    return new Promise(function(resolve) {
      const img = new Image();
      img.onload = function() {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          // throws on a tainted canvas, e.g. when index.html is opened from file://
          const dataURL = canvas.toDataURL('image/' + logoConfig.format.toLowerCase());

          logoCache[logoConfig.id] = {
            data: dataURL,
            format: logoConfig.format
          };
        } catch (e) {
          console.error('Failed to cache logo:', logoConfig.file, e);
        } finally {
          resolve();
        }
      };
      img.onerror = function() {
        console.error('Failed to load logo:', logoConfig.file);
        resolve();
      };
      img.src = 'images/logos/' + logoConfig.file;
    });
  }));
}

// ==================== DARK MODE FUNCTIONALITY ====================

// The script at the top of <body> sets the starting mode before the first paint;
// this labels the toggle and follows the system and the toggle from then on
function initDarkMode() {
  const darkModeToggle = document.getElementById('darkModeToggle');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function applyDarkMode(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    // The icon (CSS) and label show the mode a click switches to
    const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    darkModeToggle.title = label;
    darkModeToggle.setAttribute('aria-label', label);
  }

  // Label the toggle for the mode the script at the top of <body> chose
  applyDarkMode(document.body.classList.contains('dark-mode'));

  // Follow system changes while there's no saved choice
  systemDark.addEventListener('change', function(e) {
    if (localStorage.getItem('darkMode') === null) {
      applyDarkMode(e.matches);
    }
  });

  // Toggle dark mode on button click
  darkModeToggle.addEventListener('click', function() {
    const isDark = !document.body.classList.contains('dark-mode');
    applyDarkMode(isDark);

    // Save only a choice that differs from the system, so switching
    // back to the system's mode resumes following it
    if (isDark === systemDark.matches) {
      localStorage.removeItem('darkMode');
    } else {
      localStorage.setItem('darkMode', isDark);
    }

  });
}

// ==================== DECK MANAGEMENT (SAVE/LOAD) ====================

function initDeckManagement() {
  const saveButton = document.getElementById('saveDeck');
  const loadButton = document.getElementById('loadDeck');
  const clearButton = document.getElementById('clearDeck');

  // Helper function to update load button state
  function updateLoadButtonState() {
    const hasSavedDeck = localStorage.getItem('savedDeck') !== null;
    loadButton.disabled = !hasSavedDeck;
    if (!hasSavedDeck) {
      loadButton.style.opacity = '0.5';
      loadButton.style.cursor = 'not-allowed';
    } else {
      loadButton.style.opacity = '1';
      loadButton.style.cursor = 'pointer';
    }
  }

  // Initialize button state on page load
  updateLoadButtonState();

  // Save deck to localStorage
  saveButton.addEventListener('click', function() {
    const deckData = {
      firstname: $('#firstname').val(),
      lastname: $('#lastname').val(),
      event: $('#event').val(),
      eventdate: $('#eventdate').val(),
      eventlocation: $('#eventlocation').val(),
      deckname: $('#deckname').val(),
      deckdesigner: $('#deckdesigner').val(),
      deckmain: $('#deckmain').val(),
      deckside: $('#deckside').val(),
      deckformat: $('#deckformat').val(),
      sortorder: $('input[name="sortorder"]:checked').prop('id'),
      decksheet: $('input[name="decksheetformat"]:checked').prop('id'),
      separateBasicLands: $('#separate-basic-lands').is(':checked'),
      savedAt: new Date().toISOString()
    };

    localStorage.setItem('savedDeck', JSON.stringify(deckData));

    // Update load button state
    updateLoadButtonState();

    // Visual feedback
    saveButton.textContent = '✅ Saved!';
    setTimeout(() => {
      saveButton.textContent = '💾 Save Decklist';
    }, 2000);

  });

  // Load deck from localStorage
  loadButton.addEventListener('click', function() {
    const savedDeck = localStorage.getItem('savedDeck');

    if (!savedDeck) {
      alert('No saved decklist found. Save a decklist first!');
      return;
    }

    const deckData = JSON.parse(savedDeck);

    // Load all fields
    $('#firstname').val(deckData.firstname || '');
    $('#lastname').val(deckData.lastname || '');
    $('#event').val(deckData.event || '');
    $('#eventdate').val(deckData.eventdate || '');
    $('#eventlocation').val(deckData.eventlocation || '');
    $('#deckname').val(deckData.deckname || '');
    $('#deckdesigner').val(deckData.deckdesigner || '');
    $('#deckmain').val(deckData.deckmain || '');
    $('#deckside').val(deckData.deckside || '');
    $('#deckformat').val(deckData.deckformat || '');
    if ($('#deckformat').val() === null) { $('#deckformat').val(''); }
    $('#separate-basic-lands').prop('checked', deckData.separateBasicLands || false);

    // Restore sort order
    if (deckData.sortorder) {
      $('#' + deckData.sortorder).click();
    }

    // Restore deck sheet format
    if (deckData.decksheet) {
      $('#' + deckData.decksheet).click();
    }

    // Trigger PDF regeneration
    pdfChangeWait();

    // Visual feedback
    loadButton.textContent = '✅ Loaded!';
    setTimeout(() => {
      loadButton.textContent = '📂 Load Decklist';
    }, 2000);

  });

  // Clear all fields
  clearButton.addEventListener('click', function() {
    if (!confirm('Are you sure you want to clear all fields?')) {
      return;
    }

    // Clear all input fields
    $('#firstname, #lastname, #event, #eventdate, #eventlocation, #deckname, #deckdesigner, #deckformat, #deckimport, #deckmain, #deckside').val('');
    $('#separate-basic-lands').prop('checked', false);

    // Reset to default sort order
    $('#sort-type').click();

    // Trigger PDF regeneration
    pdfChangeWait();

  });
}

// ==================== AUTOCOMPLETE FUNCTIONALITY ====================

function initAutocomplete() {
  const MAX_SUGGESTIONS = 10;
  const MAX_LIST_HEIGHT = 220;
  const GAP = 4;

  // The deck box the list belongs to, its suggestions ({name, rank}), and the highlighted
  // one, which Enter and Tab take
  let textarea = null;
  let suggestions = [];
  let selectedIndex = 0;

  const container = $('<div class="autocomplete-suggestions" role="listbox"></div>');
  $('body').append(container);
  container.hide();

  // Pressing on the list must not take focus from the deck box: the typing would go
  // nowhere afterwards, and on a phone the keyboard would close
  container.on('mousedown pointerdown', function(e) {
    e.preventDefault();
  });
  container.on('click', '.autocomplete-suggestion', function() {
    selectSuggestion($(this).index());
  });

  // Attach autocomplete to deck textareas
  $('#deckmain, #deckside').on('input', function(e) {
    // Only suggest while the user is typing: programmatic fills (deck import,
    // undo, picking a suggestion) and pasted or dropped lists shouldn't open it
    const inputType = e.originalEvent && e.originalEvent.inputType;
    if (!inputType || inputType === 'insertFromPaste' || inputType === 'insertFromDrop') {
      hideAutocomplete();
      return;
    }

    const searchTerm = currentSearchTerm(this);
    if (searchTerm) {
      showAutocomplete($(this), searchTerm);
    } else {
      hideAutocomplete();
    }
  });

  // Handle keyboard navigation
  $('#deckmain, #deckside').on('keydown', function(e) {
    if (!container.is(':visible') || e.isComposing) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Enter after a name typed in full ends the line, as it would with no list open
      if (e.key === 'Enter' && selectedIndex === 0 && suggestions[0].rank === 0) {
        hideAutocomplete();
        return;
      }
      e.preventDefault();
      selectSuggestion(selectedIndex);
    } else if (e.key === 'Escape') {
      hideAutocomplete();
    }
  });

  // Hide autocomplete when clicking outside
  $(document).on('click', function(e) {
    if (!$(e.target).closest('#deckmain, #deckside, .autocomplete-suggestions').length) {
      hideAutocomplete();
    }
  });

  // Keep the list beside the caret as the page scrolls, the deck box scrolls, or a phone's
  // keyboard opens or closes, once a frame at most
  let repositionFrame = null;
  function reposition() {
    if (repositionFrame || !container.is(':visible')) return;
    repositionFrame = requestAnimationFrame(function() {
      repositionFrame = null;
      if (container.is(':visible')) positionList();
    });
  }
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('scroll', reposition);
    window.visualViewport.addEventListener('resize', reposition);
  }
  $('#deckmain, #deckside').on('scroll', reposition);

  // The card name on the caret's line, after any quantity ("4 " or "2x "), once it is
  // at least two characters long; otherwise null
  function currentSearchTerm(box) {
    const textBeforeCursor = box.value.substring(0, box.selectionStart);
    const currentLine = textBeforeCursor.substring(textBeforeCursor.lastIndexOf('\n') + 1);
    const matchWithQuantity = currentLine.match(/^\s*\d+x?\s+(.+)$/i);
    const matchWithoutQuantity = currentLine.match(/^\s*([a-zA-Z].*)$/i);
    const name = (matchWithQuantity || matchWithoutQuantity || [])[1];
    return name && name.length >= 2 ? name : null;
  }

  // Every card whose loose name contains the term, best first: the name itself, then
  // names starting with it, then names with a word starting with it, then the rest,
  // alphabetically within each. Loose forms, so "fire ice" finds Fire // Ice
  function searchCards(searchTerm) {
    const term = Decklist.searchKey(searchTerm);
    const matches = [];
    if (!term || typeof cards === 'undefined') return matches;

    for (const [key, card] of Decklist.searchIndex()) {
      const at = key.indexOf(term);
      if (at === -1) continue;
      let rank = 3;
      if (key === term) {
        rank = 0;
      } else if (at === 0) {
        rank = 1;
      } else if (startsWord(key, term, at)) {
        rank = 2;
      }
      matches.push({ key: key, name: card.n, rank: rank });
    }

    matches.sort(function(a, b) {
      return a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    return matches.slice(0, MAX_SUGGESTIONS);
  }

  // Whether the term starts a word of the name anywhere from `at` on
  function startsWord(key, term, at) {
    for (; at !== -1; at = key.indexOf(term, at + 1)) {
      if (!/[a-z0-9]/.test(key[at - 1])) return true;
    }
    return false;
  }

  function showAutocomplete(box, searchTerm) {
    suggestions = searchCards(searchTerm);
    if (suggestions.length === 0) {
      hideAutocomplete();
      return;
    }

    textarea = box;
    selectedIndex = 0;
    container.empty();
    suggestions.forEach(function(suggestion) {
      container.append($('<div class="autocomplete-suggestion" role="option"></div>').text(suggestion.name));
    });
    updateSelection();
    container.show();
    container.scrollTop(0);
    positionList();
  }

  // Puts the list under the caret's line, or above it when there's more room there inside
  // what's visible: a phone's keyboard shrinks the visual viewport, and a list below the
  // box would sit behind it
  function positionList() {
    const box = textarea[0];
    const rect = box.getBoundingClientRect();
    const caret = caretLine(box);
    const lineTop = Math.min(Math.max(rect.top + caret.top, rect.top), rect.bottom);
    const lineBottom = Math.min(lineTop + caret.height, rect.bottom);

    const view = window.visualViewport;
    const viewTop = view ? view.offsetTop : 0;
    const viewBottom = view ? view.offsetTop + view.height : window.innerHeight;
    const spaceBelow = viewBottom - lineBottom - 2 * GAP;
    const spaceAbove = lineTop - viewTop - 2 * GAP;

    container.css({ maxHeight: 'none', left: rect.left + window.scrollX + 'px', width: rect.width + 'px' });
    const listHeight = Math.min(container.outerHeight(), MAX_LIST_HEIGHT);
    const below = spaceBelow >= listHeight || spaceBelow >= spaceAbove;
    const height = Math.max(Math.min(listHeight, below ? spaceBelow : spaceAbove), 0);

    container.css({
      maxHeight: height + 'px',
      top: (below ? lineBottom + GAP : lineTop - GAP - height) + window.scrollY + 'px'
    });
  }

  // The caret's line inside a textarea, as {top, height} from its border edge with its
  // scroll applied, measured on a hidden copy with the same width and text styles so
  // wrapped lines count
  function caretLine(box) {
    const style = getComputedStyle(box);
    const mirror = document.createElement('div');
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
      'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize'].forEach(function(prop) {
      mirror.style[prop] = style[prop];
    });
    Object.assign(mirror.style, {
      position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', border: '0', boxSizing: 'border-box',
      width: box.clientWidth + 'px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word'
    });
    mirror.textContent = box.value.substring(0, box.selectionEnd);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const line = { top: box.clientTop + marker.offsetTop - box.scrollTop, height: marker.offsetHeight };
    mirror.remove();
    return line;
  }

  function hideAutocomplete() {
    container.hide();
    selectedIndex = 0;
    suggestions = [];
  }

  function updateSelection() {
    container.find('.autocomplete-suggestion').each(function(index) {
      $(this).toggleClass('selected', index === selectedIndex).attr('aria-selected', index === selectedIndex);
    });
    const selected = container.find('.selected')[0];
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  function selectSuggestion(index) {
    const box = textarea[0];
    const cardName = suggestions[index].name;
    const cursorPos = box.selectionStart;
    const text = box.value;
    const textBeforeCursor = text.substring(0, cursorPos);
    const textAfterCursor = text.substring(cursorPos);

    // Get the current line
    const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
    const currentLine = textBeforeCursor.substring(currentLineStart);

    // Extract quantity, default to "1 " if none present
    const match = currentLine.match(/^\s*(\d+x?\s+)/i);
    const quantity = match ? match[1] : '1 ';

    // Replace current line with selected card
    box.value = text.substring(0, currentLineStart) + quantity + cardName + textAfterCursor;

    // Keep typing in the deck box, with the cursor after the card name
    hideAutocomplete();
    box.focus();
    const newCursorPos = currentLineStart + quantity.length + cardName.length;
    box.setSelectionRange(newCursorPos, newCursorPos);

    // Trigger change event
    textarea.trigger('input');
  }
}
