fn main() {
    let input = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://youtu.be/jNQXAC9IVRw".into());
    match piku_core::links::source(&input) {
        Ok(source) => println!("{}\n{}\n{}", source.platform, source.url, source.key),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
