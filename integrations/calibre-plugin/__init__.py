from calibre.customize import InterfaceActionBase


class XandrioPlugin(InterfaceActionBase):
    name = 'Xandrio'
    description = 'Send selected books or an entire calibre library to Xandrio'
    supported_platforms = ['windows', 'osx', 'linux']
    author = 'Proof of Reach'
    version = (1, 0, 0)
    minimum_calibre_version = (7, 0, 0)
    actual_plugin = 'calibre_plugins.xandrio.action:XandrioAction'
