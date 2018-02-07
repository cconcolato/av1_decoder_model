var fs = require('fs');

var frames = JSON.parse(fs.readFileSync(process.argv[2]));

var timescale = 1000;
var display_rate = +process.argv[3] || 30;
var decode_rate =  +process.argv[4] || 32;
var level_width =  +process.argv[5] || 352;
var level_height = +process.argv[6] || 288;
var level_max_luma_sample_per_sec = level_width*level_height*decode_rate;
var initial_display_delay = timescale*4/decode_rate || +process.argv[7] || 0;
var nb_frames = +process.argv[8] || frames.length;

var BufferPool = [];
var BufferPoolSize = 9;
var VBI = [];
var cfbi;

var decode_number = 0;
var presentation_order = 0;

var now = 0;

/************************* Run **********************************/

process_frames();
generate_csv();

/************************* Main function **********************************/

function process_frames() {
	initialize_buffer_pool();

	for (var i = 0; i < nb_frames; i++) {
		var frame = frames[i];
		frame.bitstream_number = i; // only helpful for logging
		if (frame.show_existing_frame > -1) {
			// The frame does not need any decode
			// it will just update an existing buffer, marking it as needed by the display
			// and it does not progress the time (instantaneous processing)
			var buffer_idx = VBI[ frame.show_existing_frame ];
			markBufferAsNeededForPresentation(buffer_idx, presentation_order);
			frame.presentation_order = presentation_order; // for logging
			frame.display_start_time = getFrameDisplayStartTime(presentation_order);
		    debug(frame, "updated buffer status post show_existing_frame processing: "+getBufferStatusString());
		    presentation_order++;
		} else {
			// The frame needs to be decoded into a buffer
			// its processing will not be instantaneous
			// it needs to take into account what's happening in the display process
			frame.decode_number = decode_number; // only helpful for logging
			decode_number++;
			var wait_time = 0; // potential time that the decoder has to wait for the display to release a buffer
			var cfbi = findEmptyBuffer();
			if (cfbi !== -1) {
				debug(frame, "buffer found: "+cfbi+", frame can be decoded immediately");
			} else {
				// No available buffer
				// All buffers either contain a frame that is still needed by the decoder (for reference) or that has not been presented yet
				// The decoder needs to wait for a buffer to be released by the display
				do { // because a frame may be displayed multiple times (e.g. consecutive show_existing_frame) we need a loop to make sure it's released
					var res = findBufferWithLowestPresentationOrder();
					if (res.index === -1) {
						// this can only happen if all player_ref_count are 0 (otherwise, one of them would have a presentation order)
						// so this is an error case
						error(frame, "Error: No buffer left to decode");
						return;
					}
					// no decoding can happen until the display of this frame, we can safely progress time
					var display_time = getFrameDisplayStartTime(res.presentation_order);
					if (display_time >= now) {
						wait_time += display_time - now;
					} else {
						// should never happen
						error(frame, "Error: Frame missed presentation deadline (pn:"+ res.presentation_order +"): "+ getDurationString(display_time, timescale));
						return;
					}
					// potentially release the buffer
					debug(frame, "Frame (pn: "+ res.presentation_order + ") is presented at time "+ getDurationString(display_time, timescale))
					markBufferAsUsedByPresentation(res.index);
					debug(frame, "updated buffer status post display");
					// search again for an empty buffer
					cfbi = findEmptyBuffer();
				} while (cfbi == -1);
				debug(frame, "Decoding of frame needed to wait for "+wait_time+" to have a buffer");
			}
			// progress time by wait time
			now += wait_time;
			frame.decode_start_time = now;
			debug(frame, "starting decoding");
			// decode and progress time by decode time
			now += getFrameDecodeDuration(frame);
			frame.decode_end_time = now;
			debug(frame, "ending decoding");
			// update VBI and Buffers
			update_ref_buffers(cfbi, frame.refresh_frame_flags);
			debug(frame, "updated buffer info post decoding: "+getBufferStatusString());
			// update display status
			if (frame.show_frame !== 0) {
				markBufferAsNeededForPresentation(cfbi, presentation_order);
				frame.presentation_order = presentation_order;
				frame.display_start_time = getFrameDisplayStartTime(presentation_order);
				debug(frame, "updated buffer info post show_frame processing: "+getBufferStatusString());
			    presentation_order++;
			}
			// during decoding of this frame, some other frames may have been displayed, check if their buffers need to be released
			for (var buffer_index = 0; buffer_index < BufferPoolSize; buffer_index++) {
				if (BufferPool[ buffer_index ].player_ref_count !== 0) {
					for (var j = 0; j < BufferPool[ buffer_index ].player_ref_count; j++) {
						var display_time = getFrameDisplayStartTime(BufferPool[ buffer_index ].presentation_frame_number[ j ]);
						if (display_time <= now) {
							if (display_time < now && buffer_index === cfbi) {
								error(frame, "Error: Frame should have been presented before being decoded");
								return;
							} else {
								debug(frame, "Frame in buffer "+buffer_index+" (pn: "+BufferPool[ buffer_index ].presentation_frame_number[ j ]+") has been presented during decode at time "+getDurationString(display_time, timescale));
								markBufferAsUsedByPresentation(buffer_index);
								debug(frame, "updated buffer status post display");
							}
						}
					}
				}
			}
		}
	}
	console.log("Bitstream successfully processed!");
}

/************************* Helper functions **********************************/

function findEmptyBuffer() {
	for (var i = 0; i < BufferPoolSize; i++ ) {
		if ( BufferPool[ i ].decoder_ref_count === 0 &&
			 BufferPool[ i ].player_ref_count  === 0 ) {
			return i;
		}
	}
	return -1;
}

function markBufferAsNeededForPresentation(idx, order) {
    // Note: one frame may be displayed multiple times.
	var idx2;
	idx2 = BufferPool[ idx ].player_ref_count;
    BufferPool[ idx ].presentation_frame_number[ idx2 ] = order;
   	BufferPool[ idx ].player_ref_count++;
}

function markBufferAsUsedByPresentation(idx) {
	BufferPool[ idx ].player_ref_count--;
	// presentation order should be in order
	BufferPool[ idx ].presentation_frame_number.shift();
}

function update_ref_buffers (idx, refresh_frame_flags) {
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

function findBufferWithLowestPresentationOrder() {
	var result = {};
	result.presentation_order = Infinity;
	result.index = -1;
	for (var i = 0; i < BufferPoolSize; i++ ) {
		if ( BufferPool[ i ].player_ref_count !== 0 ) {
			for (var j = 0; j < BufferPool[ i ].player_ref_count; j++) {
				var order = BufferPool[ i ].presentation_frame_number[ j ];
				if (order < result.presentation_order) {
					result.presentation_order = order;
					result.index = i;
				}
			}
		}
	}
	return result;
}

function initialize_buffer_pool( ) {
	var i;
    for ( i = 0; i < BufferPoolSize; i++ ) {
    	BufferPool[i] = {};
        BufferPool[i].index = i;
        BufferPool[i].decoder_ref_count = 0;
        BufferPool[i].player_ref_count = 0;
        BufferPool[i].presentation_frame_number = [];
    }
    for ( i = 0; i < 8; i++ ) {
        VBI[ i ] = -1;
    }
    cfbi = -1;
}

function getFrameDecodeDuration(frame) {
	return timescale * frame.width * frame.height / level_max_luma_sample_per_sec;
}

function getFrameDisplayStartTime(presentation_order) {
	return initial_display_delay + timescale * presentation_order / display_rate;
}

/************************* Logging functions **********************************/
function generate_csv() {
	console.log("bitstream_number\tdecode_start_time\tdecode_end_time\tdisplay_start_time");
	for (var i = 0; i < nb_frames; i++) {
		var frame = frames[i];
		if (frame.bitstream_number === undefined) return;
		console.log(frame.bitstream_number +"\t"+ (frame.decode_start_time || " ") +"\t"+ (frame.decode_end_time || " ") +"\t"+ (frame.display_start_time || " "));
	}
}

function log(frame, msg) {
	var framePart = "\tframe infos (bn/sef/sf/dn/pn/dst/det/pt): "+frame.bitstream_number+", "+frame.show_existing_frame+", "+(frame.show_frame === undefined?"":"1")+", "+(frame.decode_number === undefined?"NaN":frame.decode_number)+", "+(frame.presentation_order === undefined?"NaN":frame.presentation_order)+", "+getDurationString(frame.decode_start_time, timescale)+", "+getDurationString(frame.decode_end_time, timescale)+", "+getDurationString(frame.display_start_time, timescale)
	console.log("t: " + getDurationString(now, timescale) + framePart + "\t"+msg);
}

function debug(frame, msg) {
	return;
	log(frame, msg);
}

function error(frame, msg) {
	log(frame, msg);
}

function getDurationString (duration, _timescale) {
	if (duration === undefined) return "   NaN";
	var neg;
	/* Helper function to print a number on a fixed number of digits */
	function pad(number, length) {
		var str = '' + number;
		var a = str.split('.');
		while (a[0].length < length) {
			a[0] = '0' + a[0];
		}
		return a.join('.');
	}
	if (duration < 0) {
		neg = true;
		duration = -duration;
	} else {
		neg = false;
	}
	var timescale = _timescale || 1;
	var duration_sec = duration/timescale;
	var hours = Math.floor(duration_sec/3600);
	duration_sec -= hours * 3600;
	var minutes = Math.floor(duration_sec/60);
	duration_sec -= minutes * 60;
	var msec = duration_sec*1000;
	duration_sec = Math.floor(duration_sec);
	msec -= duration_sec*1000;
	msec = Math.floor(msec);
	//return (neg ? "-": "")+hours+":"+pad(minutes,2)+":"+pad(duration_sec,2)+"."+pad(msec,3);
	return pad(duration_sec,2)+"."+pad(msec,3);
}

function getBufferStatusString() {
	return "";
	var s = "[";
	for (var i = 0; i < BufferPoolSize; i++ ) {
		s += BufferPool[i].decoder_ref_count;
		s += "/";
        s += BufferPool[i].player_ref_count;
		s += "/";
        s += BufferPool[i].presentation_frame_number;
        if (i < BufferPoolSize - 1) {
			s += ", ";
        }
    }
	s += "], [";
    for (var i = 0; i < 8; i++ ) {
        s += VBI[ i ];
        if (i < 7) {
			s += ", ";
        }
    }
	s += "], ";
    s += cfbi;
    return s;
}













