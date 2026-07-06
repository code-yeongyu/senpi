package terminalimage

import "encoding/binary"

// GetImageDimensions decodes the pixel dimensions of a raster image from its raw
// bytes, dispatching on MIME type. Returns nil when the format is unsupported or
// the header cannot be parsed. Port of terminal-image.getImageDimensions (which
// takes base64; neo callers hold the decoded bytes from the clipboard adapter,
// so this variant reads raw bytes directly).
func GetImageDimensions(data []byte, mimeType string) *ImageDimensions {
	switch mimeType {
	case "image/png":
		return pngDimensions(data)
	case "image/jpeg":
		return jpegDimensions(data)
	case "image/gif":
		return gifDimensions(data)
	case "image/webp":
		return webpDimensions(data)
	default:
		return nil
	}
}

// pngDimensions reads width/height from the IHDR chunk. Port of getPngDimensions.
func pngDimensions(b []byte) *ImageDimensions {
	if len(b) < 24 {
		return nil
	}
	if b[0] != 0x89 || b[1] != 0x50 || b[2] != 0x4e || b[3] != 0x47 {
		return nil
	}
	width := int(binary.BigEndian.Uint32(b[16:20]))
	height := int(binary.BigEndian.Uint32(b[20:24]))
	return &ImageDimensions{WidthPx: width, HeightPx: height}
}

// jpegDimensions scans SOF markers for width/height. Port of getJpegDimensions.
func jpegDimensions(b []byte) *ImageDimensions {
	if len(b) < 2 || b[0] != 0xff || b[1] != 0xd8 {
		return nil
	}
	offset := 2
	for offset < len(b)-9 {
		if b[offset] != 0xff {
			offset++
			continue
		}
		marker := b[offset+1]
		if marker >= 0xc0 && marker <= 0xc2 {
			height := int(binary.BigEndian.Uint16(b[offset+5 : offset+7]))
			width := int(binary.BigEndian.Uint16(b[offset+7 : offset+9]))
			return &ImageDimensions{WidthPx: width, HeightPx: height}
		}
		if offset+3 >= len(b) {
			return nil
		}
		length := int(binary.BigEndian.Uint16(b[offset+2 : offset+4]))
		if length < 2 {
			return nil
		}
		offset += 2 + length
	}
	return nil
}

// gifDimensions reads the logical-screen size. Port of getGifDimensions.
func gifDimensions(b []byte) *ImageDimensions {
	if len(b) < 10 {
		return nil
	}
	sig := string(b[0:6])
	if sig != "GIF87a" && sig != "GIF89a" {
		return nil
	}
	width := int(binary.LittleEndian.Uint16(b[6:8]))
	height := int(binary.LittleEndian.Uint16(b[8:10]))
	return &ImageDimensions{WidthPx: width, HeightPx: height}
}

// webpDimensions handles VP8/VP8L/VP8X chunks. Port of getWebpDimensions.
func webpDimensions(b []byte) *ImageDimensions {
	if len(b) < 30 {
		return nil
	}
	if string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return nil
	}
	switch string(b[12:16]) {
	case "VP8 ":
		width := int(binary.LittleEndian.Uint16(b[26:28]) & 0x3fff)
		height := int(binary.LittleEndian.Uint16(b[28:30]) & 0x3fff)
		return &ImageDimensions{WidthPx: width, HeightPx: height}
	case "VP8L":
		if len(b) < 25 {
			return nil
		}
		bits := binary.LittleEndian.Uint32(b[21:25])
		width := int(bits&0x3fff) + 1
		height := int((bits>>14)&0x3fff) + 1
		return &ImageDimensions{WidthPx: width, HeightPx: height}
	case "VP8X":
		width := int(b[24]) | int(b[25])<<8 | int(b[26])<<16
		height := int(b[27]) | int(b[28])<<8 | int(b[29])<<16
		return &ImageDimensions{WidthPx: width + 1, HeightPx: height + 1}
	}
	return nil
}
