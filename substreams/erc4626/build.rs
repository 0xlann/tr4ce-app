use std::env;
use std::path::PathBuf;

fn main() {
    // Generated bindings go to OUT_DIR, not src/. They are rewritten on every build and marked
    // "do not edit by hand", so keeping them out of the source tree keeps the format and lint
    // gates pointed at hand-written code only.
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));

    substreams_ethereum::Abigen::new("Erc4626", "abi/erc4626.json")
        .expect("failed to load the ERC-4626 ABI")
        .generate()
        .expect("failed to generate ERC-4626 bindings")
        .write_to_file(out_dir.join("erc4626_abi.rs"))
        .expect("failed to write ERC-4626 bindings");

    prost_build::compile_protos(&["proto/tr4ce/v1/vault.proto"], &["proto/"]).unwrap();

    println!("cargo:rerun-if-changed=abi/erc4626.json");
    println!("cargo:rerun-if-changed=proto/tr4ce/v1/vault.proto");
}
