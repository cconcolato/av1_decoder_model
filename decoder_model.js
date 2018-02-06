var fs = require('fs');

var frames = JSON.parse(fs.readFileSync(process.argv[2]));

var index_to_numbers = [-1, -1, -1, -1, -1, -1, -1, -1];
var index_to_frame = [ null, null, null, null, null, null, null, null];

var decode_number = 0;
var display_number = 0;
var decode_time = 0;
var display_time = 0;

var display_rate = 30;
var decode_rate = 30;
var level_width = 352;
var level_height = 288;
var level_max_luma_sample_per_sec = level_width*level_height*decode_rate;
var timescale = 1000;
var max_display_decode_shift = 0;

var timeline_string = "";

for (var i = 0; i < frames.length; i++) {
	var frame = frames[i];
	frame.number = i;

	if (frame.show_existing_frame === -1) {
		frame.decode_number = decode_number;
		decode_number++;
	} else {
		frame.decode_number = -1;
	}

	if (frame.show_existing_frame !== -1 || frame.show_frame === 1) {
		frame.display_number = display_number;
		display_number++;
	} else {
		frame.display_number = -1;
	}

	// mapping the local decode number (i.e. number between 0 and 8) to a global decode number (unique in the stream)
	// based on the appearance of this local decode number in the reference buffer map after a refresh_frame_flags update
	if (i+1 < frames.length) {
		var next_frame = frames[i+1];
		for (var j = 0; j < frame.ref_frame_map.length; j++) {
			if (frame.ref_frame_map[j] !== next_frame.ref_frame_map[j]) {
				var index = next_frame.ref_frame_map[j];
				index_to_numbers[index] = frame.decode_number;
				index_to_frame[index] = frame;
				break;
			}
		}
	}
	// saving the mapping in each frame for debug
	frame.index_to_numbers = index_to_numbers.slice();

	// convert the frame indices in the reference buffer based on the above mapping
	frame.ref_frame_map_number = [];
	for (var j = 0; j < frame.ref_frame_map.length; j++) {
		frame.ref_frame_map_number[j] = index_to_numbers[frame.ref_frame_map[j]];
	}

	// convert the frame indices in each frame's list of referenced frames based on above mapping
	if (frame.ref_frame_used) {
		frame.ref_frame_used_number = [];
		for (var j = 0; j < frame.ref_frame_used.length; j++) {
			frame.ref_frame_used_number[j] = index_to_numbers[frame.ref_frame_used[j]];
		}
	}

	// update times associated to the current frame
	// first decode time
	if (frame.show_existing_frame === -1) {
		console.log("Frame "+frame.decode_number+" decode_time: "+decode_time);
		// compute wait time if any
		var wait_time = 0;
		for(var j = 0; j < frame.refresh_frame_flags.length; j++) {
			if (frame.refresh_frame_flags[j] === 1) {
				// before updating a slot in the reference buffer, we need to make sure the display time
				// for the frame in the slot has passed (frame can be safely overwritten)
				var overwritten_frame_idx = frame.ref_frame_map[j];
				if (overwritten_frame_idx !== -1) { // for first frame, the ref map is not initialized and contains -1
					var overwritten_frame = index_to_frame[overwritten_frame_idx];
					if (overwritten_frame !== null) {
						if (overwritten_frame.display_start_time !== undefined) { // the frames to overwrite was not meant for display
							if (overwritten_frame.display_start_time > decode_time) {
								var frame_wait_time = overwritten_frame.display_start_time - decode_time;
								console.log("Refreshed slot "+j+" contains frame "+overwritten_frame.decode_number+", display_start_time: "+overwritten_frame.display_start_time+", available in "+frame_wait_time+" ms");
								if (frame_wait_time > wait_time) {
									wait_time = frame_wait_time;
									console.log("Updating maximum wait time for this frame");
								} else {
									console.log("Previous refreshed slot introduced a larger delay");
								}
							} else {
								console.log("Refreshed slot "+j+" containing frame "+overwritten_frame.decode_number+" can be safely overwritten, display_start_time: "+overwritten_frame.display_start_time);
							}
						} else {
							console.log("Refreshed slot "+j+" containing frame "+overwritten_frame.decode_number+" can be safely overwritten, it does not have a display_time, show_frame: "+overwritten_frame.show_frame);
						}
					} else {
						console.log("Refreshed slot "+j+" does have an associated frame?!!");
					}
				} else {
					console.log("Refreshed slot "+j+" to overwrite not yet initialized");
				}
			}
		}
		if (wait_time > 0) {
			console.log("Final wait time for this frame: "+wait_time);
		}

		frame.decode_start_time = wait_time + decode_time;
		frame.decode_end_time = frame.decode_start_time + timescale * frame.width * frame.height / level_max_luma_sample_per_sec;
		decode_time = frame.decode_end_time;
	}
	// then display time
	if (frame.show_existing_frame !== -1 || frame.show_frame === 1) {
		frame.display_start_time = display_time;
		frame.display_end_time = display_time + timescale / display_rate;
		display_time = frame.display_end_time;
	} else {
		frame.display_number = -1;
	}

	// update the decode to display delay
	if (frame.decode_end_time !== undefined && frame.display_start_time !== undefined) {
		var shift = frame.decode_end_time - frame.display_start_time;
		if (shift > max_display_decode_shift) max_display_decode_shift = shift;
	}


	// update timeline info
	if (frame.show_existing_frame !== -1) {
		timeline_string += (index_to_numbers[frame.show_existing_frame]+"* ");
	} else {
		timeline_string += (frame.decode_number+((frame.show_frame === 1) ? "'" : "")+" ");
	}
}
console.log(timeline_string);
console.log("max_display_decode_shift: "+max_display_decode_shift+" ms");

fs.writeFileSync('out.json', JSON.stringify(frames));