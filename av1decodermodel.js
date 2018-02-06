var fs = require('fs');
var process = require('process');

var inputFile = process.argv[0];
var inputData = JSON.parse(fs.readFileSync(inputFile));

var REFS_PER_FRAME = 8;
var DPB = [];
for (var i = 0; i < REFS_PER_FRAME; i++) {
	DPB[i] = {};
}
var frameToDecode = 0;
var frameToPresent = 0;
var endPresentationTime = -1;
var currentVideoFrame = 0;
var decodeOrder = 0;
var DecodeOrders = [];
while (frameToDecode < inputData.frames.length) {
	//decodeFrame();
	var frame = inputData.frames[frameToDecode];
	var refresh_frame_flags;
	var ref_frame_idx;
	if (frame.show_existing_frame) {
		var frame_to_show_idx = frame.frame_to_show_map_idx;
		refresh_frame_flags = 0;
		currentVideoFrame++;
	} else {
		var isIntra = frame.type === "KeyFrame" || frame.type === "IntraOnlyFrame";
		if (frame.type === "KeyFrame") {
			refresh_frame_flags = 0xFF;
			currentVideoFrame = 0;
		} else {
			if (frame.type === "IntraOnlyFrame") {
				refresh_frame_flags = frame.refresh_frame_flags;
			} else {
				if (frame.type = "SwitchFrame") {
					refresh_frame_flags = 0xFF;
				} else { // "InterFrame"
					refresh_frame_flags = frame.refresh_frame_flags;
				}
				ref_frame_idx = frame.ref_frame_idx;
			}
		}
	}
	if (!frame.show_frame) {
		decodeOrder = currentVideoFrame + frame.frame_offset_update;
	} else {
		decodeOrder = currentVideoFrame;
		currentVideoFrame++;
	}
	if (!isIntra) {
		for( var i = 0; i < REFS_PER_FRAME; i++ ) {
        	DecodeOrders[ LAST_FRAME + i ] = RefDecodeOrder[ ref_frame_idx[ i ] ]
    	}
	}
	for (var i = 0; i < 8; i++) {
		if (frame.refresh_frame_flags[i]) {
			DPB[i].decodeFrame = frameToDecode;
		}
	}
	if (frame.show_frame) {
		frameToPresent++;
	} else if (frame.show_existing_frame) {
		//
		frameToPresent++;
	} else {

	}
	checkDeadline();
	frameToDecode++;
	waitForDPBSlot();
}
