import numpy as np
from pdf2fxl.reflow.typesize import measure_segment
from pdf2fxl.reflow.segment import Segment


def _striped(page_h=200, page_w=100, band_h=8, pitch=16, n=5, top=20):
    """White page with n dark horizontal bands of thickness band_h at given pitch."""
    img = np.full((page_h, page_w), 255, np.uint8)
    for i in range(n):
        y = top + i * pitch
        img[y:y + band_h, 10:90] = 0
    return img


def test_measures_line_count_and_size():
    img = _striped()
    seg = Segment(page_index=0, type="text", bbox=(0, 0, 100, 200), text="x")
    measure_segment(img, seg)
    assert seg.n_lines == 5
    # band thickness ~ 8 px
    assert 6 <= seg.size_px <= 10


def test_single_line_uses_band_thickness():
    img = _striped(n=1)
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 100, 200), text="Title")
    measure_segment(img, seg)
    assert seg.n_lines == 1
    assert 6 <= seg.size_px <= 10


def test_blank_region_is_safe():
    img = np.full((50, 50), 255, np.uint8)
    seg = Segment(page_index=0, type="text", bbox=(0, 0, 50, 50), text="")
    measure_segment(img, seg)
    assert seg.size_px == 0.0
    assert seg.n_lines == 1


from pdf2fxl.reflow.typesize import detect_weight_centering


def test_centered_block_flagged():
    # ink only in the middle third of the crop width
    img = np.full((40, 300), 255, np.uint8)
    img[10:30, 120:180] = 0
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 300, 40), text="Hi")
    detect_weight_centering(img, seg, page_width=300)
    assert seg.centered is True


def test_left_flush_block_not_centered():
    img = np.full((40, 300), 255, np.uint8)
    img[10:30, 0:60] = 0
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 300, 40), text="Hi")
    detect_weight_centering(img, seg, page_width=300)
    assert seg.centered is False


def test_ink_columns_recorded():
    img = np.full((40, 300), 255, np.uint8)
    img[10:30, 120:180] = 0
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 300, 40), text="Hi")
    detect_weight_centering(img, seg, page_width=300)
    assert seg.ink_left > 0 and seg.ink_right > seg.ink_left


# --- content-invariant size proxy (the heading-hierarchy root-cause fix) --------
import cv2
from PIL import Image, ImageDraw, ImageFont
from pdf2fxl.reflow.hierarchy import finalize_line_sizes

_FONT = "assets/fonts/NotoSerif-Regular.ttf"


def _render_seg(text, pt, type_="title"):
    font = ImageFont.truetype(_FONT, pt)
    img = Image.new("RGB", (1600, 420), "white")
    ImageDraw.Draw(img).multiline_text((20, 20), text, fill="black", font=font,
                                       spacing=int(pt * 0.4))
    gray = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)
    ys, xs = np.where(gray < 128)
    seg = Segment(page_index=0, type=type_,
                  bbox=(xs.min() - 3, ys.min() - 3,
                        (xs.max() - xs.min()) + 6, (ys.max() - ys.min()) + 6),
                  text=text.replace("\n", " "))
    measure_segment(gray, seg)
    return seg


def test_line_px_is_content_invariant_at_one_point_size():
    """The exact bug: at a single 48pt, the old size_px ranged 21..47 (>2x) by
    glyph content and spurious line splits. line_px must now be ~constant."""
    segs = [_render_seg(t, 48) for t in [
        "AI", "OVERVIEW", "Cloud AI Deployment",
        "Generative Intelligence Strategy typography"]]
    finalize_line_sizes(segs)
    lp = [s.line_px for s in segs]
    # residual is only the all-caps vs ascender/descender difference (offset later
    # by the caps bonus in prominence); the >2x length/split noise is gone.
    assert max(lp) / min(lp) < 1.6
    # none of these single lines is spuriously split (the old "Cloud AI Deployment"
    # measured n_lines=2; a long descender-heavy line measured n_lines=2).
    assert all(s.n_lines == 1 for s in segs)


def test_bigger_font_measures_bigger_line_px():
    small = _render_seg("Chapter", 20)
    big = _render_seg("Chapter", 44)
    finalize_line_sizes([small, big])
    assert big.line_px > 1.5 * small.line_px


def test_two_line_heading_counts_two_lines():
    assert _render_seg("Cloud AI\nDeployment Strategy", 48).n_lines == 2


def test_descender_heavy_single_line_stays_one_line():
    # many descenders (g,y,p,j) once split a single line into 2 bands; peak-count
    # keeps it one line.
    assert _render_seg("apology typography physiology", 40).n_lines == 1


def test_size_px_semantics_unchanged_for_body_fixture():
    # size_px (legacy, consumed by body_size + dropcap) must keep its old meaning.
    img = _striped()
    seg = Segment(page_index=0, type="text", bbox=(0, 0, 100, 200), text="x")
    measure_segment(img, seg)
    assert 6 <= seg.size_px <= 10
    assert seg.n_lines == 5
