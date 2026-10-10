//! Times loading a score JSON file natively: cargo run --release --example load -- file.json
fn main() {
    let path = std::env::args().nth(1).expect("file");
    let json = std::fs::read_to_string(path).unwrap();
    let t = std::time::Instant::now();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    println!("parse to Value {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let score = tabstudio_core::model::Score::from_value(value).unwrap();
    println!("into the model {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let doc = tabstudio_core::Document::from_json(&json).unwrap();
    println!("Document::from_json {:?} ({} bars)", t.elapsed(), score.master_bars.len());
    let t = std::time::Instant::now();
    let out = doc.to_json();
    println!("to_json {:?} ({} MB)", t.elapsed(), out.len() / 1_000_000);
}
