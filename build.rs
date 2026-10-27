fn main() {
    // Touch the embedded directories so the binary is re-linked whenever the
    // asset bundles change. (Without this, `cargo build` thinks the source
    // tree is up-to-date when only `static/` or `templates/` change.)
    println!("cargo:rerun-if-changed=static");
    println!("cargo:rerun-if-changed=static/css");
    println!("cargo:rerun-if-changed=static/js");
    println!("cargo:rerun-if-changed=static/js/tools");
    println!("cargo:rerun-if-changed=static/lib");
    println!("cargo:rerun-if-changed=static/img");
    println!("cargo:rerun-if-changed=templates");
    println!("cargo:rerun-if-changed=locales");
    println!("cargo:rerun-if-changed=build.rs");
}
