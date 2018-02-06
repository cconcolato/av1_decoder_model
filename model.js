var fs = require('fs');

var bitstream = {};
bitstream.frame_index = 0;
bitstream.frames = JSON.parse(fs.readFileSync(process.argv[2]));

var BufferPool = [];
var BufferPoolSize = 9;
var VBI = [];
var cfbi;

var SHOW_EXISTING_FRAME = 1;
var SHOW_FRAME = 2;
var NO_SHOW_FRAME = 3;

var decode_clock;
var presentation_order = 0;
var display_clock = 0;
var presentation_frame_number = 0;

var nb_frames_to_display = 100;

function WallClockTime() {
	return Date.now();
}

function log() {
	//console.log(BufferPool, VBI, cfbi, decode_clock, display_clock, presentation_order, presentation_frame_number);
}

function initialize_buffer_pool( ) {
	var i;
    for ( i = 0; i < BufferPoolSize; i++ ) {
    	BufferPool[i] = {};
        BufferPool[i].decoder_ref_count = 0;
        BufferPool[i].player_ref_count = 0;
        BufferPool[i].presentation_frame_number = [ -1 ];
        BufferPool[i].decode_buffer_wait_time = 0;
        BufferPool[i].display_buffer_wait_time = 0;
    }
    for ( i = 0; i < 8; i++ ) {
        VBI[ i ] = -1;
    }
    cfbi = -1;
}

function get_buffer() {
	var i;
  	// Mark the time we start waiting for a free frame buffer.
  	var start_time = WallClockTime();

  	// Wait for a free frame buffer to become available.
  	do {
    	for ( i = 0; i < BufferPoolSize; i++ ) {
      		if ( BufferPool[ i ].decoder_ref_count === 0 &&
           		 BufferPool[ i ].player_ref_count  === 0 ) {
        		// Calculate the time spent waiting for the free buffer.
        		var end_time = WallClockTime();
        		BufferPool[ i ].decode_buffer_wait_time = end_time - start_time;
        		return i;
      		}
    	}
  	} while ( true );
}


function decode_frame ( buffer_idx ) {
    // Decodes one frame into BufferPool[ buffer_idx ].
	console.log("Decoding frame into buffer "+buffer_idx);
	log();
	return bitstream.frames[bitstream.frame_index].refresh_frame_flags;
}

function get_frame_type(frame) {
	if (frame.show_existing_frame !== -1) {
		return SHOW_EXISTING_FRAME;
	} else if (frame.show_frame === 1) {
		return SHOW_FRAME;
	} else {
		return NO_SHOW_FRAME;
	}
}

function update_ref_buffers ( idx, refresh_frame_flags ) {
	var i;
    for ( i = 0; i < 8; i++ ) {
        if ( refresh_frame_flags[i] === 1 ) {
            if ( VBI[ i ] !== -1 ) {
                BufferPool[ VBI[i] ].decoder_ref_count--;
            }
            VBI[ i ] = idx;
            BufferPool[ idx ].decoder_ref_count++;
        }
    }
}

function decode_single(decode_frame_period) {
    if (bitstream.frame_index >= bitstream.frames.length) {
    	return;
    } else {
		var target_idx;
		var frame = bitstream.frames[bitstream.frame_index];
		var frame_type = get_frame_type(frame);
		if ( frame_type !== SHOW_EXISTING_FRAME ) {
			// Decoder requires a free buffer from the Buffer Pool.
			cfbi = get_buffer();

		   	// Make sure buffer is not re-assigned during decode.
		   	BufferPool[ cfbi ].decoder_ref_count++;

			var refresh_frame_flags = decode_frame(cfbi);

			// Frame decoded, update the reference buffers.
		    target_idx = cfbi;
			update_ref_buffers ( cfbi, refresh_frame_flags);
		} else {
		    target_idx = VBI[ frame.show_existing_frame ];
		    if (target_idx === undefined) {
			    console.log("show_existing_frame: "+frame.show_existing_frame);
		    }
		}

		// Mark buffer with presentation frame order if frame is
		// presentable, i.e. a SHOW_FRAME or SHOW_EXISTING_FRAME.
		if ( frame_type !== NO_SHOW_FRAME ) {
			var idx2;
		    // Note: one frame may be displayed multiple times.
			idx2 = BufferPool[ target_idx ].player_ref_count;
		    BufferPool[ target_idx ].presentation_frame_number[ idx2 ] = presentation_order;
		    BufferPool[ target_idx ].player_ref_count++;
		    presentation_order++;
		}

		// Advance the decode clock if there was a decode event.
		// i.e. a SHOW_FRAME or NO_SHOW_FRAME.
		if ( frame_type != SHOW_EXISTING_FRAME ) {
		    decode_clock += decode_frame_period;
		    frame.end_decode_time = decode_clock;

			// Decoder no longer needs the buffer to decode frame into.
			BufferPool[ cfbi ].decoder_ref_count--;
		}

		bitstream.frame_index++;

    	setImmediate(decode_single, decode_frame_period);
	}
}

function decode_process( decode_frame_period ) {
	console.log("Decoding process starting");
    // Initialize the decode clock to -Pdec.
    // Should be synchronized with initialization of the Presentation clock.
	decode_clock = -1 * decode_frame_period;
	decode_single(decode_frame_period);
}

function get_next_presentation_frame_buffer( presentation_idx , _start_time) {
    // Mark the time we start waiting for the next presentation frame.
    var start_time = _start_time || WallClockTime();
    var i;

    // Wait for the next presentation frame buffer to become available.
    for ( i = 0; i < BufferPoolSize; i++ ) {
        // Same frame may be displayed multiple times.
        for ( j = 0; j < BufferPool[ i ].player_ref_count; j++ ) {
            if ( BufferPool[ i ].presentation_frame_number[ j ] === presentation_idx ) {
                // Calculate the time spent waiting for the next presentation frame.
                var end_time = WallClockTime();
                BufferPool[ i ].display_buffer_wait_time = end_time - start_time;
                return { start_time: start_time, idx: i };
            }
        }
    }

    return { start_time: start_time, idx: -1 };
}

function DisplayFrame(idx) {
	console.log("Frame from buffer "+idx+" displaying");
}

function display_single(display_period, _start_time) {
    var next = get_next_presentation_frame_buffer( presentation_frame_number, _start_time);
    if ( next.idx !== -1 ) {
        DisplayFrame( next.idx );
        BufferPool[ next.idx ].player_ref_count--;
        presentation_frame_number++;
		display_clock += display_period;
		console.log("End Display Time: "+display_clock);
		setImmediate(display_single, display_period);
    } else {
    	if (presentation_frame_number < nb_frames_to_display) {
			setImmediate(display_single, display_period, next.start_time);
    	}
    }
}

function display_process (display_period, initial_display_delay) {
	console.log("Display process starting");
    // Start the presentation clock at the specified time offset.
    // Should be synchronized with initialization of the Decode clock.
    display_clock = initial_display_delay;
    display_single(display_period);

}

initialize_buffer_pool();
decode_process(30);
display_process(30, 1000);



