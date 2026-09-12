import logging
import torch
CUDA = torch.cuda.is_available()
DEVICE = 'cuda' if CUDA else 'cpu'
LOGGER = logging.getLogger(__name__)
