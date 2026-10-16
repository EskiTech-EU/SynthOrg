//! synthorg-rembg: the background of a photo removed by a segmentation model.
//!
//! One program, one job, run inside a container with no network: it reads the
//! photo and the model, writes the photo as a PNG whose alpha is the matte
//! the model produced, and says how long it took. The models are the ones
//! the rembg project publishes as ONNX files, run on the CPU — which is what
//! a pod of SynthOrg has — by ONNX Runtime, the library they are published
//! for: the one Alpine packages, loaded when the program starts.
//!
//!   synthorg-rembg --model m.onnx --in photo.jpg --out photo.png
//!                  [--mean r,g,b] [--std r,g,b] [--size 1024] [--json]
//!   synthorg-rembg --encoder e.onnx --decoder d.onnx --box x0,y0,x1,y1 --in photo.jpg --out photo.png [--json]
//!   synthorg-rembg --describe --model m.onnx   (what the file says of itself, as JSON)
//!   synthorg-rembg --check                     (the library loads: says so and leaves)
//!
//! What can be read from the model is read from the model, not told from
//! outside: the size of its input is the one its file declares (`--size` is
//! used only by a model whose input is of any size), and whether its output
//! is logits or already a matte is seen in the output itself (values outside
//! 0..1 are logits, and go through a sigmoid). The one thing a file does not
//! say is how its authors normalised the pictures it was trained on:
//! `--mean` and `--std`, the ImageNet ones unless told otherwise.
//!
//! With `--encoder` and `--decoder` the model is Segment Anything, which is
//! told where the object is: `--box` is a rectangle around it, in the photo's
//! own pixels, and the matte is the object inside it and nothing else. The
//! encoder reads the photo with its longer side at 1024 and does its own
//! normalising; the decoder takes what the encoder saw and the rectangle (its
//! two corners, as points labelled 2 and 3) and gives the object's mask at
//! the photo's size, as logits.
//!
//! The steps of the first form are rembg's: resize to the model's square, normalise, run, take
//! the first output, stretch it to 0..1 by its own minimum and maximum,
//! resize the matte back to the photo, and use it as alpha. With `--json`
//! the last line of stdout is a JSON object with the timings, what was read
//! from the model, the output's range and the peak memory, for the
//! measurements SynthOrg keeps.
use std::time::Instant;

use image::imageops::FilterType;
use image::{GrayImage, ImageBuffer, Rgba, RgbaImage};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

type Failure = Box<dyn std::error::Error>;

/// Where Alpine's package puts the library; `ORT_DYLIB_PATH` names another.
const RUNTIME: &str = "/usr/lib/libonnxruntime.so.1";

fn load_runtime() -> Result<(), Failure> {
    let path = std::env::var("ORT_DYLIB_PATH").unwrap_or_else(|_| RUNTIME.to_string());
    ort::init_from(path).commit()?;
    Ok(())
}

const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

struct Args {
    model: String,
    input: String,
    output: String,
    /// For a model that takes any size; one that declares its own ignores it.
    size: usize,
    mean: [f32; 3],
    std: [f32; 3],
    describe: bool,
    json: bool,
    /// Segment Anything: its two files and the rectangle around the object.
    encoder: String,
    decoder: String,
    rect: Option<[f32; 4]>,
}

/// Four numbers separated by commas: a rectangle by its corners.
fn quad(value: Option<String>) -> Option<[f32; 4]> {
    let parts: Vec<f32> = value?.split(',').filter_map(|v| v.trim().parse().ok()).collect();
    match parts.as_slice() {
        [a, b, c, d] if parts.iter().all(|v| v.is_finite()) && c > a && d > b => Some([*a, *b, *c, *d]),
        _ => None,
    }
}

/// Three numbers separated by commas, as `--mean` and `--std` take them.
fn triple(value: Option<String>) -> Option<[f32; 3]> {
    let parts: Vec<f32> = value?.split(',').filter_map(|v| v.trim().parse().ok()).collect();
    match parts.as_slice() {
        [a, b, c] if parts.iter().all(|v| v.is_finite()) => Some([*a, *b, *c]),
        _ => None,
    }
}

fn usage() -> ! {
    eprintln!("usage: synthorg-rembg --model <onnx> --in <image> --out <png> [--mean r,g,b] [--std r,g,b] [--size 1024] [--json] | --encoder <onnx> --decoder <onnx> --box x0,y0,x1,y1 --in <image> --out <png> [--json] | --describe --model <onnx> | --check");
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut args = Args { model: String::new(), input: String::new(), output: String::new(), size: 1024, mean: MEAN, std: STD, describe: false, json: false, encoder: String::new(), decoder: String::new(), rect: None };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--model" => args.model = it.next().unwrap_or_else(|| usage()),
            "--in" => args.input = it.next().unwrap_or_else(|| usage()),
            "--out" => args.output = it.next().unwrap_or_else(|| usage()),
            "--size" => args.size = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage()),
            "--mean" => args.mean = triple(it.next()).unwrap_or_else(|| usage()),
            "--std" => args.std = triple(it.next()).unwrap_or_else(|| usage()),
            "--describe" => args.describe = true,
            "--encoder" => args.encoder = it.next().unwrap_or_else(|| usage()),
            "--decoder" => args.decoder = it.next().unwrap_or_else(|| usage()),
            "--box" => args.rect = Some(quad(it.next()).unwrap_or_else(|| usage())),
            "--json" => args.json = true,
            "--check" => {
                if let Err(error) = load_runtime() {
                    eprintln!("synthorg-rembg: ONNX Runtime does not load: {error}");
                    std::process::exit(1);
                }
                println!("synthorg-rembg {}: ONNX Runtime loaded", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--version" => {
                println!("synthorg-rembg {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            _ => usage(),
        }
    }
    let object = !args.encoder.is_empty() || !args.decoder.is_empty() || args.rect.is_some();
    if object && (args.encoder.is_empty() || args.decoder.is_empty() || args.rect.is_none() || args.input.is_empty() || args.output.is_empty() || !args.model.is_empty()) {
        usage();
    }
    if (!object && args.model.is_empty()) || (!args.describe && (args.input.is_empty() || args.output.is_empty())) || args.size < 32 || args.size > 2048 || args.std.iter().any(|v| *v == 0.0) {
        usage();
    }
    args
}

/// Peak resident memory of this process in kB, as Linux reports it; 0 elsewhere.
fn peak_rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse().ok()))
        .unwrap_or(0)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("synthorg-rembg: {error}");
        std::process::exit(1);
    }
}

/// The dimensions a tensor is declared with, as JSON: a number, or -1 where the file leaves it open.
fn dims_json(dims: &[i64]) -> String {
    format!("[{}]", dims.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(","))
}

/// A model's session: every processor the pod was given, and the basic level of graph
/// optimisation (the extended ones refuse some of these models — BiRefNet, on ONNX Runtime 1.23 —
/// and gain little on the others).
fn open(path: &str, threads: usize) -> Result<Session, Failure> {
    Ok(Session::builder()?.with_optimization_level(GraphOptimizationLevel::Level1)?.with_intra_threads(threads)?.commit_from_file(path)?)
}

/// The photo with the matte as its alpha, written as a PNG.
fn write_cutout(photo: &RgbaImage, alpha: impl Fn(u32, u32) -> u8, output: &str) -> Result<(), Failure> {
    let (width, height) = photo.dimensions();
    let mut out: RgbaImage = ImageBuffer::new(width, height);
    for (x, y, pixel) in out.enumerate_pixels_mut() {
        let p = photo.get_pixel(x, y);
        let a = (p[3] as u32 * alpha(x, y) as u32 / 255) as u8;
        *pixel = Rgba([p[0], p[1], p[2], a]);
    }
    out.save_with_format(output, image::ImageFormat::Png).map_err(|e| format!("cannot write {output}: {e}"))?;
    Ok(())
}

/// Segment Anything: the object inside a rectangle.
fn run_object(args: &Args) -> Result<(), Failure> {
    let started = Instant::now();
    let rect = args.rect.ok_or("missing --box")?;
    load_runtime()?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let photo = image::open(&args.input).map_err(|e| format!("cannot read {}: {e}", args.input))?.to_rgba8();
    let (width, height) = photo.dimensions();

    // The encoder's view: the longer side at 1024, the other in proportion; height, width, channels; 0..255.
    let scale = 1024.0 / width.max(height) as f32;
    let (w, h) = (((width as f32 * scale).round() as u32).max(1), ((height as f32 * scale).round() as u32).max(1));
    let small = image::imageops::resize(&photo, w, h, FilterType::Triangle);
    let mut pixels = vec![0.0f32; (w * h * 3) as usize];
    for (x, y, pixel) in small.enumerate_pixels() {
        let at = ((y * w + x) * 3) as usize;
        for c in 0..3 {
            pixels[at + c] = pixel[c] as f32;
        }
    }
    let (embedding_shape, embedding) = {
        let mut encoder = open(&args.encoder, threads)?;
        let outputs = encoder.run(ort::inputs![Tensor::from_array(([h as usize, w as usize, 3], pixels))?])?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;
        (shape.iter().map(|d| *d as usize).collect::<Vec<usize>>(), data.to_vec())
    };
    let encoded_ms = started.elapsed().as_millis();

    // The rectangle as the decoder wants it: its two corners in the encoder's view, labelled 2 and 3.
    let corners = vec![rect[0] * scale, rect[1] * scale, rect[2] * scale, rect[3] * scale];
    let mut decoder = open(&args.decoder, threads)?;
    let outputs = decoder.run(ort::inputs![
        "image_embeddings" => Tensor::from_array((embedding_shape, embedding))?,
        "point_coords" => Tensor::from_array(([1usize, 2, 2], corners))?,
        "point_labels" => Tensor::from_array(([1usize, 2], vec![2.0f32, 3.0]))?,
        "mask_input" => Tensor::from_array(([1usize, 1, 256, 256], vec![0.0f32; 256 * 256]))?,
        "has_mask_input" => Tensor::from_array(([1usize], vec![0.0f32]))?,
        "orig_im_size" => Tensor::from_array(([2usize], vec![height as f32, width as f32]))?,
    ])?;
    let (shape, logits) = outputs["masks"].try_extract_tensor::<f32>()?;
    let plane = width as usize * height as usize;
    if shape.len() != 4 || logits.len() < plane {
        return Err(format!("unexpected mask of {} values for {width}x{height}", logits.len()).into());
    }
    let score = outputs["iou_predictions"].try_extract_tensor::<f32>().ok().and_then(|(_, v)| v.first().copied()).unwrap_or(0.0);
    // The object is where the logits are positive. A steep sigmoid keeps that and softens only the
    // very edge; SynthOrg fits the edge to the photo afterwards.
    write_cutout(&photo, |x, y| {
        let v = logits[y as usize * width as usize + x as usize] * 4.0;
        ((1.0 / (1.0 + (-v).exp())) * 255.0).round() as u8
    }, &args.output)?;
    let total_ms = started.elapsed().as_millis();
    if args.json {
        println!(
            "{{\"ms\":{total_ms},\"encodeMs\":{encoded_ms},\"decodeMs\":{},\"width\":{width},\"height\":{height},\"size\":1024,\"threads\":{threads},\"score\":{score},\"vmHwmKb\":{}}}",
            total_ms - encoded_ms,
            peak_rss_kb()
        );
    }
    Ok(())
}

fn run() -> Result<(), Failure> {
    let args = parse_args();
    if args.rect.is_some() {
        return run_object(&args);
    }
    let started = Instant::now();

    load_runtime()?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let mut session = open(&args.model, threads)?;
    let loaded_ms = started.elapsed().as_millis();

    let declared: Vec<i64> = session.inputs.first().and_then(|i| i.input_type.tensor_shape()).map(|s| s.iter().copied().collect()).unwrap_or_default();
    if args.describe {
        let side = |list: &[ort::session::Input]| list.iter().map(|i| format!("{{\"name\":{:?},\"shape\":{}}}", i.name, dims_json(&i.input_type.tensor_shape().map(|s| s.iter().copied().collect::<Vec<i64>>()).unwrap_or_default()))).collect::<Vec<_>>().join(",");
        let outputs = session.outputs.iter().map(|o| format!("{{\"name\":{:?},\"shape\":{}}}", o.name, dims_json(&o.output_type.tensor_shape().map(|s| s.iter().copied().collect::<Vec<i64>>()).unwrap_or_default()))).collect::<Vec<_>>().join(",");
        println!("{{\"inputs\":[{}],\"outputs\":[{}]}}", side(&session.inputs), outputs);
        return Ok(());
    }
    if declared.len() != 4 || declared[1] != 3 {
        return Err(format!("this model does not take a picture: its input is {}", dims_json(&declared)).into());
    }
    // The file's own size where it declares one; the argument where it takes any.
    let fixed = declared[2] > 0 && declared[3] > 0;
    if fixed && declared[2] != declared[3] {
        return Err(format!("this model takes a {}x{} picture: only square inputs are handled", declared[3], declared[2]).into());
    }
    let size = if fixed { declared[2] as usize } else { args.size };
    let size_from = if fixed { "model" } else { "argument" };

    let photo = image::open(&args.input).map_err(|e| format!("cannot read {}: {e}", args.input))?.to_rgba8();
    let (width, height) = photo.dimensions();
    let decoded_ms = started.elapsed().as_millis() - loaded_ms;

    // The model's input: a square of its own size, channels first, normalised.
    let small = image::imageops::resize(&photo, size as u32, size as u32, FilterType::Lanczos3);
    let mut input = vec![0.0f32; 3 * size * size];
    for (x, y, pixel) in small.enumerate_pixels() {
        for c in 0..3 {
            input[c * size * size + y as usize * size + x as usize] = (pixel[c] as f32 / 255.0 - args.mean[c]) / args.std[c];
        }
    }

    let tensor = Tensor::from_array(([1usize, 3, size, size], input))?;
    let outputs = session.run(ort::inputs![tensor])?;
    let inferred_ms = started.elapsed().as_millis() - decoded_ms - loaded_ms;

    // The first output is the fused prediction: stretched by its own range, as rembg does.
    let (_, data) = outputs[0].try_extract_tensor::<f32>()?;
    let mut values: Vec<f32> = data.to_vec();
    if values.len() < size * size {
        return Err(format!("unexpected output size {} for {size}x{size}", values.len()).into());
    }
    // What the model gave, before anything is done to it: tells logits from probabilities when a new model is tried.
    let (raw_lo, raw_hi) = values.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    // Values outside 0..1 are logits: the matte is their sigmoid. Seen in the output, not told from outside.
    let sigmoid = raw_lo < -0.01 || raw_hi > 1.01;
    if sigmoid {
        for v in values.iter_mut() {
            *v = 1.0 / (1.0 + (-*v).exp());
        }
    }
    let (lo, hi) = values.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let span = if hi > lo { hi - lo } else { 1.0 };
    let mask: GrayImage = ImageBuffer::from_fn(size as u32, size as u32, |x, y| {
        let v = (values[(y as usize) * size + x as usize] - lo) / span;
        image::Luma([(v.clamp(0.0, 1.0) * 255.0).round() as u8])
    });
    let mask = image::imageops::resize(&mask, width, height, FilterType::Triangle);

    write_cutout(&photo, |x, y| mask.get_pixel(x, y)[0], &args.output)?;
    let total_ms = started.elapsed().as_millis();

    if args.json {
        println!(
            "{{\"ms\":{total_ms},\"decodeMs\":{decoded_ms},\"loadMs\":{loaded_ms},\"inferMs\":{inferred_ms},\"width\":{width},\"height\":{height},\"size\":{size},\"sizeFrom\":\"{size_from}\",\"sigmoid\":{sigmoid},\"threads\":{threads},\"outMin\":{raw_lo},\"outMax\":{raw_hi},\"vmHwmKb\":{}}}",
            peak_rss_kb()
        );
    }
    Ok(())
}
