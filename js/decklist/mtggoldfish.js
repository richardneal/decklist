/* exported MTGGoldfish */

var MTGGoldfish = {
    isGoldfish: function(url) {
        return ~url.toLowerCase().indexOf("mtggoldfish.com");
    },
    getDecklist: function(url) {
        id = url.match(/\d+/);
        url = 'https://www.mtggoldfish.com/deck/download/' + id;
        $.ajax({
            url: 'https://cors-anywhere.herokuapp.com/' + url,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type':'text/plain'
            },
            method: 'GET',
            dataType: 'text',
            data: '',
            success: function(result){
                split = result.split('\r\n\r\n');
                $("#deckmain").html(split[0]);
                $("#deckside").html(split[1]);
            }
          });
    }
  };
  