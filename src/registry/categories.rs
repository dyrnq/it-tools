//! 工具分类。顺序即左侧导航与首页分组的展示顺序。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Crypto,
    Converter,
    Web,
    ImagesVideos,
    Development,
    Network,
    Math,
    Measurement,
    Text,
    Data,
}

impl Category {
    /// 导航与首页的展示顺序
    pub const ALL: [Category; 10] = [
        Category::Crypto,
        Category::Converter,
        Category::Web,
        Category::ImagesVideos,
        Category::Development,
        Category::Network,
        Category::Math,
        Category::Measurement,
        Category::Text,
        Category::Data,
    ];

    /// 序列化标识
    pub fn id(self) -> &'static str {
        match self {
            Category::Crypto => "crypto",
            Category::Converter => "converter",
            Category::Web => "web",
            Category::ImagesVideos => "images-and-videos",
            Category::Development => "development",
            Category::Network => "network",
            Category::Math => "math",
            Category::Measurement => "measurement",
            Category::Text => "text",
            Category::Data => "data",
        }
    }

    /// 语言包 key：`tools.categories.crypto`
    pub fn name_key(self) -> &'static str {
        match self {
            Category::Crypto => "tools.categories.crypto",
            Category::Converter => "tools.categories.converter",
            Category::Web => "tools.categories.web",
            // 参考项目里这个分类的 key 带空格，保留以复用现成语言包
            Category::ImagesVideos => "tools.categories.images and videos",
            Category::Development => "tools.categories.development",
            Category::Network => "tools.categories.network",
            Category::Math => "tools.categories.math",
            Category::Measurement => "tools.categories.measurement",
            Category::Text => "tools.categories.text",
            Category::Data => "tools.categories.data",
        }
    }

    /// 语言包缺失时的英文兜底
    pub fn label(self) -> &'static str {
        match self {
            Category::Crypto => "Crypto",
            Category::Converter => "Converter",
            Category::Web => "Web",
            Category::ImagesVideos => "Images and videos",
            Category::Development => "Development",
            Category::Network => "Network",
            Category::Math => "Math",
            Category::Measurement => "Measurement",
            Category::Text => "Text",
            Category::Data => "Data",
        }
    }
}
